import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {AppError, Client, Disk, Downloader, baseName, collectAssets, feeMatches, checkedURL, safeName, zipPaths, unzip, unwrapBody, assetKind, failureIdsFromLog, creatorIdFromInput, creatorRules, progressPath} from '../core.mjs';
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
  assert.equal(baseName(rule(), post()), '作家_261101投稿分_無題_p1');
  assert.equal(baseName(rule(), post('1', {publishedDatetime: '2026-10-31T23:00:00Z'})), '作家_261101投稿分_無題_p1');
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
  assert.equal(zipPaths([entry({filename:'a?.png'}),entry({filename:'a*.png'})],'p',true).length,2);
});
test('ZIP streams actual compressed data with Japanese filenames, grouped and flat', async () => {
  for (const grouped of [true,false]) {
    const disk = new Disk(new MemoryDirectory());
    await disk.write(['comic.zip'], await archive([['漫画/01.png','page1'],['漫画/02.png','page2']]));
    const records = await unzip(disk,['comic.zip'],['creator'],'作家_261101投稿分_無題_p1_001',grouped,new AbortController().signal);
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
  const folder = root.dirs.get('作家__sample').dirs.get('作家_261101投稿分_無題_p1');
  folder.files.delete('作家_261101投稿分_無題_p1_001.jpg');
  assert.equal((await new Downloader(client,disk,()=>{},{onExisting:async()=>({action:'redownload'})}).run([rule()])).saved,1);
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
  assert.equal(await (await disk.file(['作家__sample','作家_261101投稿分_無題_p1','作家_261101投稿分_無題_p1_001.zip'])).text(),'broken');
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

test('post titles are included in folder and image names and sanitized',async()=>{
  const p=post('42',{title:'漫画/第1話: 完成版'}),root=new MemoryDirectory(),disk=new Disk(root),client=fakeClient([p]);
  const base=baseName(rule(),p);
  assert.equal(base,'作家_261101投稿分_漫画_第1話_ 完成版_p42');
  assert.equal((await new Downloader(client,disk).run([rule()])).saved,1);
  assert.equal(await(await disk.file(['作家__sample',base,base+'_001.jpg'])).text(),'image');
  assert.equal([...safeName('😀'.repeat(49),48)].length,48);
});
test('existing posts prompt and support redownload with apply-all',async()=>{
  const c=fakeClient([post('1'),post('2')]),disk=new Disk(new MemoryDirectory());
  await new Downloader(c,disk).run([rule()]);let prompts=0;
  const result=await new Downloader(c,disk,()=>{},{onExisting:async()=>{prompts++;return{action:'redownload',applyAll:true};}}).run([rule()]);
  assert.equal(prompts,1);assert.equal(result.saved,2);assert.equal(c.downloads,4);
});
test('skip choices leave existing content untouched',async()=>{
  const c=fakeClient(),disk=new Disk(new MemoryDirectory());await new Downloader(c,disk).run([rule()]);let prompts=0;
  const result=await new Downloader(c,disk,()=>{},{onExisting:async()=>{prompts++;return{action:'skip'};}}).run([rule()]);
  assert.equal(prompts,1);assert.equal(result.skipped,1);assert.equal(c.downloads,1);
});
test('older naming policy is still detected before downloading',async()=>{
  const root=new MemoryDirectory(),disk=new Disk(root),c=fakeClient();await new Downloader(c,disk).run([rule()]);
  const statePath=['.fanbox-state','sample','1.json'],state=await disk.json(statePath),policy=JSON.parse(state.policy);policy.version=1;state.policy=JSON.stringify(policy);await disk.write(statePath,JSON.stringify(state));let prompted=false;
  const result=await new Downloader(c,disk,()=>{},{onExisting:async info=>{prompted=info.namingChanged;return{action:'skip'};}}).run([rule()]);
  assert(prompted);assert.equal(result.skipped,1);assert.equal(c.downloads,1);
});
test('matching files without management metadata also prompt',async()=>{
  const root=new MemoryDirectory(),disk=new Disk(root),c=fakeClient();await new Downloader(c,disk).run([rule()]);root.dirs.get('.fanbox-state').dirs.get('sample').files.delete('1.json');let prompts=0;
  await new Downloader(c,disk,()=>{},{onExisting:async()=>{prompts++;return{action:'skip'};}}).run([rule()]);assert.equal(prompts,1);assert.equal(c.downloads,1);
});
test('cancel at an existing post stops the batch without downloading',async()=>{
  const c=fakeClient([post('1'),post('2')]),disk=new Disk(new MemoryDirectory());await new Downloader(c,disk).run([rule()]);
  await assert.rejects(()=>new Downloader(c,disk,()=>{},{onExisting:async()=>({action:'cancel'})}).run([rule()]),{name:'AbortError'});assert.equal(c.downloads,2);
});
test('direct video and audio attachments save their original bytes and title',async()=>{
  const p=post('media',{title:'動画と音声',body:{files:[{url:'https://downloads.fanbox.cc/movie.mp4',extension:'mp4',name:'movie.mp4'},{url:'https://downloads.fanbox.cc/voice.mp3',extension:'mp3',name:'voice.mp3'}]}});
  const bytes=new Uint8Array([0,255,1,2,3,4]),client=fakeClient([p],new Blob([bytes])),disk=new Disk(new MemoryDirectory()),logs=[];
  assert.equal((await new Downloader(client,disk,text=>logs.push(text)).run([rule()])).saved,1);
  const base=baseName(rule(),p);
  for(const[name,index]of [['movie.mp4','001'],['voice.mp3','002']]){
    const f=await disk.file(['作家__sample',base,`${base}_${index}_${name}`]);assert.deepEqual(new Uint8Array(await f.arrayBuffer()),bytes);
  }
  assert(logs.some(s=>s.startsWith('動画を保存中')));assert(logs.some(s=>s.startsWith('音声を保存中')));
  assert.equal(assetKind('wav'),'音声');assert.equal(assetKind('webm'),'動画');
});


test('unfinished recovery preserves completed posts and retries partial and new posts without prompts',async()=>{
  const root=new MemoryDirectory(),disk=new Disk(root),c=fakeClient([post('1')]);
  await new Downloader(c,disk).run([rule()]);
  c.posts=async function*(){yield post('1');yield post('2');yield post('3');};
  c.api=async path=>post(new URLSearchParams(path.split('?')[1]).get('postId'));
  const base=baseName(rule(),post('2'));
  await disk.write(['作家__sample',base,base+'_001.jpg'],'partial');
  const complete=await disk.json(['.fanbox-state','sample','1.json']);
  complete.policy='old-format';await disk.write(['.fanbox-state','sample','1.json'],JSON.stringify(complete));
  const successes=[];
  const result=await new Downloader(c,disk,()=>{},{onlyUnfinished:true,onExisting:()=>{throw Error('Must not prompt');},onSuccess:({item})=>successes.push(item.id)}).run([rule()]);
  assert.equal(result.saved,2);assert.equal(result.skipped,1);assert.equal(result.errors,0);assert.equal(c.downloads,3);
  assert.deepEqual(successes,['1','2','3']);assert(await disk.valid(complete.files));
});

test('unfinished recovery repairs missing or changed files inside completed posts',async()=>{
  const root=new MemoryDirectory(),disk=new Disk(root),c=fakeClient();await new Downloader(c,disk).run([rule()]);
  const state=await disk.json(['.fanbox-state','sample','1.json']);await disk.write(state.files[0].parts,'broken');
  const result=await new Downloader(c,disk,()=>{},{onlyUnfinished:true}).run([rule()]);
  assert.equal(result.saved,1);assert.equal(c.downloads,2);
  assert.equal(await(await disk.file(state.files[0].parts)).text(),'image');
});

test('retry filter saves only recorded failures and reports post errors and completion',async()=>{
  const c=fakeClient([post('1'),post('2'),post('3')]),disk=new Disk(new MemoryDirectory()),failures=[],successes=[],scans=[];
  const original=c.response;c.response=async function(url){if(url.includes('a.jpg'))throw new AppError('HTTP 404');return original.call(this,url);};
  const options={onlyUnfinished:true,retryFilter:new Map([['sample',new Set(['2'])]]),onFailure:e=>failures.push(e),onSuccess:e=>successes.push(e.item.id),onCreatorSuccess:e=>scans.push(e.rule.id)};
  const first=await new Downloader(c,disk,()=>{},options).run([rule()]);
  assert.equal(first.errors,1);assert.equal(failures.length,1);assert.equal(failures[0].item.id,'2');assert.equal(scans.length,1);
  c.response=original;
  const result=await new Downloader(c,disk,()=>{},options).run([rule()]);
  assert.equal(result.saved,1);assert.equal(c.downloads,1);assert.deepEqual(successes,['2']);
  assert.equal(await disk.json(['.fanbox-state','sample','1.json']),null);
  assert.equal(await disk.json(['.fanbox-state','sample','3.json']),null);
});

test('listing errors have a creator-level failure; cancellation and previews do not add history',async()=>{
  const failures=[],c=fakeClient(),options={onFailure:e=>failures.push(e)};
  c.posts=async function*(){throw new AppError('list failed');};
  assert.equal((await new Downloader(c,new Disk(new MemoryDirectory()),()=>{},options).run([rule()])).errors,1);
  assert.equal(failures.length,1);assert.equal(failures[0].item,null);
  await new Downloader(c,null,()=>{},options).run([rule()],true);assert.equal(failures.length,1);
  c.posts=async function*(){throw new DOMException('cancel','AbortError');};
  await assert.rejects(()=>new Downloader(c,null,()=>{},options).run([rule()]),{name:'AbortError'});assert.equal(failures.length,1);
});

test('journal persistence errors do not turn saved posts into failures',async()=>{
  const logs=[],c=fakeClient(),disk=new Disk(new MemoryDirectory());
  const result=await new Downloader(c,disk,s=>logs.push(s),{onSuccess:()=>{throw Error('quota');}}).run([rule()]);
  assert.equal(result.saved,1);assert.equal(result.errors,0);assert(logs.some(s=>s.includes('履歴の保存に失敗')));
});

test('old log import extracts unique failed post IDs without keeping titles, URLs or other lines',()=>{
  assert.deepEqual(failureIdsFromLog('投稿保存完了：作品_p1\n投稿 123：HTTP 404 https://private.example/token\n投稿 456:失敗\n投稿 123：再失敗\n対象候補：789 ／ 題名\n無関係な投稿 999：文字列'),['123','456']);
  assert.deepEqual(failureIdsFromLog(''),[]);
});


test('manual creator input accepts FANBOX URLs and IDs and rejects other origins and malformed IDs',()=>{
  for(const input of [' sample-creator ','@sample-creator','https://sample-creator.fanbox.cc/','https://sample-creator.fanbox.cc/posts/123','https://www.fanbox.cc/@sample-creator/posts/123?x=1#comments','https://fanbox.cc/@sample-creator'])assert.equal(creatorIdFromInput(input),'sample-creator');
  for(const input of ['','https://fanbox.cc/','https://www.fanbox.cc/posts/123','https://sample.fanbox.cc.evil.test/','https://foo.bar.fanbox.cc/','https://user:pass@sample.fanbox.cc/','http://sample.fanbox.cc/','https://sample.fanbox.cc:444/','../sample','sample?x=1','@@sample','@api'])assert.throws(()=>creatorIdFromInput(input),AppError);
});

test('creator lookup handles both response wrappers and validates the returned identity',async()=>{
  for(const wrap of [c=>c,c=>({creator:c})]){
    const client=new Client(new AbortController().signal,async(url,options)=>{
      assert.equal(new URL(url).pathname,'/creator.get');assert.equal(new URL(url).searchParams.get('creatorId'),'sample');assert.equal(options.credentials,'include');
      return Response.json({body:wrap({creatorId:'sample',user:{name:'無料の作家'}})});
    });
    assert.deepEqual(await client.creator('https://sample.fanbox.cc/'),{id:'sample',name:'無料の作家',supportedFee:0});
  }
  const bad=new Client(new AbortController().signal,async()=>Response.json({body:{creatorId:'other',user:{name:'Wrong'}}}));
  await assert.rejects(()=>bad.creator('sample'),/確認できません/);
  for(const body of [null,[],{creator:null},{user:{name:'missing id'}}])assert.throws(()=>unwrapBody(body,'creator.get'),AppError);
});

test('manual creators survive an empty supporting list and remain free-only after support ends',()=>{
  const stored={free:{id:'free',name:'無料作家',manual:true,enabled:false,grouped:false,includeFree:false,amount:1000,supportedFee:1000},ended:{id:'ended',name:'終了',amount:500}};
  const merged=creatorRules([],stored);assert.equal(merged.length,1);
  const r=merged[0];assert.equal(r.id,'free');assert.equal(r.supportedFee,0);assert.equal(r.amount,0);assert.equal(r.includeFree,true);assert.equal(r.grouped,false);assert.equal(r.enabled,false);
  assert(feeMatches(0,r));assert(!feeMatches(1,r));assert(!feeMatches(500,r));
  assert.equal(creatorRules([],{...stored,free:{...r,manual:false}}).length,0);
});

test('supported and manual creators merge without duplicates and preserve settings',()=>{
  const stored={same:{id:'same',name:'Old name',manual:true,grouped:false,enabled:true,amount:500,mode:'exact',includeFree:true},free:{id:'free',name:'Free',manual:true}};
  const rules=creatorRules([{id:'same',name:'Current name',supportedFee:300}],stored);
  assert.equal(rules.length,2);assert.equal(rules[0].name,'Current name');assert.equal(rules[0].amount,300);assert.equal(rules[0].grouped,false);assert.equal(rules[0].manual,true);assert.equal(rules[0].mode,'exact');
  assert.equal(rules[1].supportedFee,0);assert.equal(rules[1].includeFree,true);
});


test('ZIP write refusal identifies its file and reuses the verified original ZIP on retry',async()=>{
  const root=new MemoryDirectory(),disk=new Disk(root),p=post('7',{body:{files:[{url:'https://downloads.fanbox.cc/application.zip?token=private',extension:'zip'}]}});
  const c=fakeClient([p],await archive([['data.bundle','data'],['Runtime/page.png','library']])),logs=[];
  let blocked=true;const handle=disk.handle.bind(disk);disk.handle=async(parts,create=true)=>{if(blocked&&create&&parts.at(-1).endsWith('.png'))throw new DOMException('untrusted message https://secret.example/token','QuotaExceededError');return handle(parts,create);};
  const first=await new Downloader(c,disk,s=>logs.push(s)).run([rule()]);assert.equal(first.errors,1);assert.equal(c.downloads,1);
  assert(logs.some(s=>s.includes('page.png')&&s.includes('空き容量')&&s.includes('ファイル作成／QuotaExceededError')));assert(!logs.some(s=>s.includes('secret.example')));
  const cache=await disk.json(['.fanbox-state','sample','7.zip-cache.json']);assert(!JSON.stringify(cache).includes('private'));assert.equal(Object.keys(cache.files).length,1);
  const second=await new Downloader(c,disk,s=>logs.push(s),{onlyUnfinished:true}).run([rule()]);assert.equal(second.errors,1);assert.equal(c.downloads,1);assert(logs.some(s=>s.includes('再ダウンロードなし')));
  assert.equal(await disk.json(['.fanbox-state','sample','7.json']),null);
  blocked=false;const recovered=await new Downloader(c,disk,()=>{},{onlyUnfinished:true}).run([rule()]);assert.equal(recovered.saved,1);assert.equal(c.downloads,1);
});

test('ZIP retries fetch again after a post revision or local original ZIP changes',async()=>{
  const p=post('8',{body:{files:[{url:'https://downloads.fanbox.cc/app.zip',extension:'zip'}]}}),disk=new Disk(new MemoryDirectory()),c=fakeClient([p],await archive([['page.png','image']]));
  const handle=disk.handle.bind(disk);disk.handle=async(parts,create=true)=>{if(create&&parts.at(-1).endsWith('.png'))throw new DOMException('full','QuotaExceededError');return handle(parts,create);};
  const run=()=>new Downloader(c,disk,()=>{},{onlyUnfinished:true}).run([rule()]);
  await run();assert.equal(c.downloads,1);p.updatedDatetime='2026-11-02T15:00:00+09:00';await run();assert.equal(c.downloads,2);
  const receipt=await disk.json(['.fanbox-state','sample','8.zip-cache.json']);const record=Object.values(receipt.files)[0].record;
  await disk.write(record.parts,'changed');await run();assert.equal(c.downloads,3);
  p.body.files[0].url+='?download=2';await run();assert.equal(c.downloads,4);
  await new Downloader(c,disk,()=>{},{onExisting:async()=>({action:'redownload'})}).run([rule()]);assert.equal(c.downloads,5);
});

test('corrupt originals have a specific error and are never retained as reusable ZIPs',async()=>{
  const p=post('9',{body:{files:[{url:'https://downloads.fanbox.cc/bad.zip',extension:'zip'}]}}),disk=new Disk(new MemoryDirectory()),c=fakeClient([p],new Blob(['broken'])),logs=[];
  assert.equal((await new Downloader(c,disk,s=>logs.push(s)).run([rule()])).errors,1);
  assert(logs.some(s=>s.includes('ZIP読み取り')&&s.includes('ZIPの構造')));
  assert.deepEqual((await disk.json(['.fanbox-state','sample','9.zip-cache.json'])).files,{});
  const good=await archive([['page.png','image']]);c.response=async()=>{c.downloads++;return new Response(good);};
  assert.equal((await new Downloader(c,disk,()=>{},{onlyUnfinished:true}).run([rule()])).saved,1);assert.equal(c.downloads,2);
});

test('ZIP CRC errors identify the failing entry and preserve CRC validation',async()=>{
  const writer=new zip.ZipWriter(new zip.BlobWriter(),{level:0});await writer.add('page.png',new zip.TextReader('original-data'));const bytes=Buffer.from(await(await writer.close()).arrayBuffer());
  const at=bytes.indexOf(Buffer.from('original-data'));assert(at>=0);bytes[at]^=1;
  const disk=new Disk(new MemoryDirectory());await disk.write(['bad.zip'],new Blob([bytes]));
  await assert.rejects(()=>unzip(disk,['bad.zip'],['creator'],'test',false,new AbortController().signal),e=>e instanceof AppError&&e.invalidArchive&&e.message.includes('page.png')&&e.message.includes('整合性チェック'));
});

test('ZIP write quota and cancellation are distinguished from corrupt data',async()=>{
  const bytes=await archive([['page.png','image']]),disk=new Disk(new MemoryDirectory());await disk.write(['test.zip'],bytes);
  const original=disk.handle.bind(disk);disk.handle=async(parts,create=true)=>{if(create&&parts.at(-1).endsWith('.png'))throw new DOMException('full','QuotaExceededError');return original(parts,create);};
  await assert.rejects(()=>unzip(disk,['test.zip'],['creator'],'test',false,new AbortController().signal),e=>e.message.includes('空き容量')&&e.message.includes('page.png')&&!e.invalidArchive);
  const c=new AbortController();c.abort();await assert.rejects(()=>unzip(disk,['test.zip'],['creator'],'test',false,c.signal),{name:'AbortError'});
});


test('incremental scan skips unchanged detail and file access, detects old edits, and retries failures',async()=>{
 const p1=post('1'),p2=post('2'),items=[p1,p2],c=fakeClient(items),disk=new Disk(new MemoryDirectory());let infos=0;const api=c.api;c.api=async p=>{infos++;return api.call(c,p);};
 const opts={incremental:true,onlyUnfinished:true,trackProgress:true};const run=()=>new Downloader(c,disk,()=>{},opts).run([rule()]);
 assert.equal((await run()).saved,2);assert.equal(infos,2);const savedProgress=await disk.json(progressPath('sample'));assert.equal(savedProgress.posts['1'].status,'complete');
 const original=disk.valid.bind(disk);disk.valid=()=>{throw Error('Unchanged files must not be scanned');};assert.equal((await run()).skipped,2);assert.equal(infos,2);disk.valid=original;
 p2.updatedDatetime='2026-11-04T00:00:00Z';assert.equal((await run()).saved,1);assert.equal(infos,3);assert.equal(c.downloads,3);
 items.push(post('3'));const response=c.response;c.response=async()=>{throw new AppError('HTTP 404');};assert.equal((await run()).errors,1);
 assert.equal((await disk.json(progressPath('sample'))).posts['3'].status,'error');c.response=response;assert.equal((await run()).saved,1);assert.equal(infos,5);
});

test('incremental first run adopts legacy completion records, while changed filters include old posts',async()=>{
 const items=[post('1'),post('2',{feeRequired:300})],c=fakeClient(items),disk=new Disk(new MemoryDirectory());await new Downloader(c,disk).run([rule({mode:'exact'})]);let infos=0;const api=c.api;c.api=async p=>{infos++;return api.call(c,p);};
 const opts={incremental:true,onlyUnfinished:true,trackProgress:true};const first=await new Downloader(c,disk,()=>{},opts).run([rule({mode:'exact'})]);assert.equal(first.skipped,1);assert.equal(infos,0);
 const expanded=await new Downloader(c,disk,()=>{},opts).run([rule()]);assert.equal(expanded.saved,1);assert.equal(infos,1);
});

test('interruption and listing failure never advance a creator checkpoint; preview is read-only',async()=>{
 const c=fakeClient(),disk=new Disk(new MemoryDirectory()),opts={incremental:true,onlyUnfinished:true,trackProgress:true};await new Downloader(c,disk,()=>{},opts).run([rule()]);const before=await disk.json(progressPath('sample'));
 c.posts=async function*(){yield post('1');throw new AppError('list failed');};await new Downloader(c,disk,()=>{},opts).run([rule()]);assert.deepEqual(await disk.json(progressPath('sample')),before);
 c.posts=async function*(){yield post('1');throw new DOMException('stop','AbortError');};await assert.rejects(()=>new Downloader(c,disk,()=>{},opts).run([rule()]),{name:'AbortError'});assert.deepEqual(await disk.json(progressPath('sample')),before);
 c.posts=async function*(){yield post('2');};await new Downloader(c,disk,()=>{},opts).run([rule()],true);assert.deepEqual(await disk.json(progressPath('sample')),before);assert.equal(c.downloads,1);
});

test('blocked DLL ZIPs are saved as Windows jobs without download failure and clear prior failure hooks',async()=>{
 const disk=new Disk(new MemoryDirectory()),c=fakeClient([post('7',{body:{files:[{url:'https://downloads.fanbox.cc/app.zip',extension:'zip'}]}})],await archive([['Runtime/plugin.dll','library']])),jobs=[],successes=[];
 const handle=disk.handle.bind(disk);disk.handle=async(parts,create=true)=>{if(create&&parts.at(-1).endsWith('.dll'))throw new TypeError('blocked');return handle(parts,create);};
 const result=await new Downloader(c,disk,()=>{},{onManualZip:({job})=>jobs.push(job),onSuccess:({item})=>successes.push(item.id)}).run([rule()]);
 assert.equal(result.errors,0);assert.equal(result.manual,1);assert.equal(result.saved,1);assert.equal(jobs.length,1);assert.deepEqual(successes,['7']);
 const job=await disk.json(['.fanbox-state','windows-unzip',jobs[0].id+'.json']);assert.equal(job.size,(await disk.file(job.archive)).size);assert.equal(job.postId,'7');assert(await disk.json(['.fanbox-state','sample','7.json']));
});
