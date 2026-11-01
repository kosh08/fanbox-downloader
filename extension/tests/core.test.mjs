import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {AppError, Client, Disk, Downloader, baseName, collectAssets, feeMatches, checkedURL, safeName, zipPaths, unzip, unwrapBody} from '../core.mjs';
const require = createRequire(import.meta.url);
globalThis.zip = require('../vendor/zip-native.min.js');
zip.configure({useWebWorkers: false});

test('new response envelopes and legacy responses normalize consistently', () => {
  const plans=[{creatorId:'a',fee:500}], pages=['https://api.fanbox.cc/post.listCreator?creatorId=a'], posts=[{id:'1'}];
  for(const [endpoint,field,value] of [['plan.listSupporting','plans',plans],['post.paginateCreator','pageUrls',pages],['post.listCreator','posts',posts]]) {
    assert.deepEqual(unwrapBody({[field]:value},endpoint),value);
    assert.deepEqual(unwrapBody(value,endpoint),value);
    assert.deepEqual(unwrapBody({[field]:[]},endpoint),[]);
  }
  assert.deepEqual(unwrapBody({post:posts[0]},'post.info'),posts[0]);
  assert.deepEqual(unwrapBody(posts[0],'post.info'),posts[0]);
  assert.equal(unwrapBody({post:null},'post.info'),null);
  assert.equal(unwrapBody(null,'post.info'),null);
});
test('unknown and unauthenticated responses fail safely without logging values', () => {
  assert.throws(()=>unwrapBody(null,'plan.listSupporting'),/ログイン/);
  assert.throws(()=>unwrapBody({unexpected:'private-response-value'},'plan.listSupporting'),error=>error.message.includes('unexpected')&&!error.message.includes('private-response-value'));
  assert.throws(()=>unwrapBody({plans:'invalid'},'plan.listSupporting'),AppError);
  assert.throws(()=>unwrapBody({post:[]},'post.info'),AppError);
});
test('API unwraps the current support-plan response including its fee', async()=>{
  const client=new Client(new AbortController().signal,async()=>Response.json({body:{plans:[{creatorId:'current',fee:1000,user:{name:'Current creator'}}]}}));
  assert.deepEqual(await client.supporting(),[{id:'current',name:'Current creator',supportedFee:1000}]);
});

const rule = extra => ({id: 'sample', name: '作家', supportedFee: 500, amount: 500, mode: 'max', grouped: true, includeFree: false, enabled: true, ...extra});
const post = (id = '1', extra) => ({id, publishedDatetime: '2026-11-01T15:00:00+09:00', updatedDatetime: '2026-11-01T15:00:00+09:00', feeRequired: 500, body: {images: [{originalUrl: 'https://downloads.fanbox.cc/a.jpg', extension: 'jpg'}]}, ...extra});
let clock = Date.now();
class MemoryDirectory {
  constructor() { this.dirs = new Map(); this.files = new Map(); }
  async getDirectoryHandle(name, {create} = {}) {
    if (!this.dirs.has(name)) { if (!create) throw new DOMException('missing', 'NotFoundError'); this.dirs.set(name, new MemoryDirectory()); }
    return this.dirs.get(name);
  }
  async getFileHandle(name, {create} = {}) {
    if (!this.files.has(name)) { if (!create) throw new DOMException('missing', 'NotFoundError'); this.files.set(name, new File([], name, {lastModified: clock++})); }
    return {
      getFile: async () => this.files.get(name),
      createWritable: async () => {
        const chunks = [], files = this.files;
        const writable = new WritableStream({write(chunk) { chunks.push(chunk); }, close() { files.set(name, new File(chunks, name, {lastModified: clock++})); }});
        writable.write = chunk => { const w = writable.getWriter(); return w.write(chunk).finally(() => w.releaseLock()); };
        writable.close = () => { const w = writable.getWriter(); return w.close().finally(() => w.releaseLock()); };
        return writable;
      }
    };
  }
}
async function archive(entries) {
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
  for (const [name, text] of entries) await writer.add(name, new zip.TextReader(text));
  return writer.close();
}
function fakeClient(posts = [post()], bytes = new Blob(['image'])) {
  return {signal: new AbortController().signal, downloads: 0, async *posts() { yield* posts; },
    async api(path) { return posts.find(p => p.id === new URLSearchParams(path.split('?')[1]).get('postId')); },
    async response() { this.downloads++; return new Response(bytes); }};
}

test('fee max, exact, free inclusion and membership cap', () => {
  assert(feeMatches(300, rule())); assert(!feeMatches(600, rule({amount: 1000})));
  assert(!feeMatches(0, rule())); assert(feeMatches(0, rule({includeFree: true, mode: 'exact'})));
  assert(!feeMatches(300, rule({mode: 'exact'}))); assert(feeMatches(500, rule({mode: 'exact'})));
});
test('naming is JST and same-day posts are distinct', () => {
  assert.equal(baseName(rule(), post()), '作家_261101投稿分_p1');
  assert.equal(baseName(rule(), post('1', {publishedDatetime: '2026-10-31T23:00:00Z'})), '作家_261101投稿分_p1');
  assert.notEqual(baseName(rule(), post()), baseName(rule(), post('2')));
  assert.equal(safeName('CON.txt'), '_CON.txt');
});
test('allowed domains and URLs', () => {
  assert(checkedURL('//downloads.fanbox.cc/a'));
  for (const url of ['https://fanbox.cc.evil.com/a','http://api.fanbox.cc/a','https://user@api.fanbox.cc/a','https://api.fanbox.cc:444/a']) assert.throws(() => checkedURL(url), AppError);
  assert.throws(() => checkedURL('https://downloads.fanbox.cc/a', true));
});
test('article assets preserve display order and deduplicate', () => {
  const p = post('1', {body: {blocks: [{imageId:'b'}, {imageId:'a'}], imageMap: {a:{originalUrl:'https://downloads.fanbox.cc/a.png'},b:{originalUrl:'https://downloads.fanbox.cc/b.png'}}}});
  assert.deepEqual(collectAssets(p).map(a=>a.url.split('/').at(-1)), ['b.png','a.png']);
});
test('API sends credentials but never exports a cookie header', async () => {
  const c = new Client(new AbortController().signal, async (url, options) => {
    assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error'); assert(!('Cookie' in options.headers));
    return Response.json({body:[{creatorId:'a', user:{name:'A'},fee:500}]});
  });
  assert.deepEqual(await c.supporting(), [{id:'a', name:'A', supportedFee:500}]);
});
test('401 has a readable authentication error', async () => {
  const c = new Client(new AbortController().signal, async()=>new Response('',{status:401}));
  await assert.rejects(()=>c.supporting(), /HTTP 401/);
});
test('ZIP preflight rejects unsafe paths, symlinks, encryption, collisions and bombs', () => {
  const entry = extra => ({filename:'01.png',uncompressedSize:10,compressedSize:10,...extra});
  for (const e of [entry({filename:'../escape'}),entry({filename:'C:\\escape'}),entry({symlink:true}),entry({encrypted:true}),entry({uncompressedSize:999999})]) assert.throws(()=>zipPaths([e],'p',true));
  assert.throws(()=>zipPaths([entry({filename:'a?.png'}),entry({filename:'a*.png'})],'p',true));
});
test('ZIP streams actual compressed data with Japanese filenames, grouped and flat', async () => {
  for (const grouped of [true,false]) {
    const disk = new Disk(new MemoryDirectory());
    await disk.write(['comic.zip'], await archive([['漫画/01.png','page1'],['漫画/02.png','page2']]));
    const records = await unzip(disk,['comic.zip'],['creator'],'作家_261101投稿分_p1_001',grouped,new AbortController().signal);
    assert.equal(records.length,2);
    assert.equal(await (await disk.file(records[0].parts)).text(),'page1');
    assert.equal(records[0].parts.length, grouped ? 4 : 2);
    assert(await disk.valid(records));
  }
});
test('completed posts skip, missing files are downloaded again', async () => {
  const root = new MemoryDirectory(), disk = new Disk(root), client = fakeClient();
  assert.equal((await new Downloader(client,disk).run([rule()])).saved,1);
  assert.equal((await new Downloader(client,disk).run([rule()])).skipped,1);
  assert.equal(client.downloads,1);
  const folder = root.dirs.get('作家__sample').dirs.get('作家_261101投稿分_p1');
  folder.files.delete('作家_261101投稿分_p1_001.jpg');
  assert.equal((await new Downloader(client,disk).run([rule()])).saved,1);
  assert.equal(client.downloads,2);
});
test('ZIP attachments save and extract end to end then skip', async () => {
  const disk = new Disk(new MemoryDirectory()), p = post('1',{body:{files:[{url:'https://downloads.fanbox.cc/a.zip',extension:'zip',name:'comic.zip'}]}});
  const client = fakeClient([p],await archive([['01.png','page1']]));
  const result = await new Downloader(client,disk).run([rule({grouped:false})]);
  assert.equal(result.saved,1); assert.equal(result.errors,0);
  assert.equal((await new Downloader(client,disk).run([rule({grouped:false})])).skipped,1);
});
test('corrupt ZIP remains on disk and does not mark the post complete', async () => {
  const root = new MemoryDirectory(), disk = new Disk(root), p = post('1',{body:{files:[{url:'https://downloads.fanbox.cc/a.zip',extension:'zip'}]}});
  const result = await new Downloader(fakeClient([p],new Blob(['broken'])),disk).run([rule()]);
  assert.equal(result.errors,1); assert.equal(result.saved,0);
  assert.equal(await disk.json(['.fanbox-state','sample','1.json']),null);
  assert.equal(await (await disk.file(['作家__sample','作家_261101投稿分_p1','作家_261101投稿分_p1_001.zip'])).text(),'broken');
});
test('restricted posts and higher-price posts are skipped', async () => {
  const c = fakeClient([post('1',{body:null}),post('2',{feeRequired:1000})]);
  const result = await new Downloader(c,new Disk(new MemoryDirectory())).run([rule()]);
  assert.equal(result.restricted,1); assert.equal(result.filtered,1); assert.equal(c.downloads,0);
});
test('preview does not touch disk or download files', async () => {
  const c = fakeClient(); assert.equal((await new Downloader(c,null).run([rule()],true)).saved,1); assert.equal(c.downloads,0);
});
test('stop cancels the run', async () => {
  const c = fakeClient(), controller = new AbortController(); c.signal = controller.signal; controller.abort();
  await assert.rejects(()=>new Downloader(c,null).run([rule()]),{name:'AbortError'});
});
