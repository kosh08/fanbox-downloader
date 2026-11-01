import {AppError, Disk, safeName} from './core.mjs';
export const REPOSITORY = 'kosh08/fanbox-downloader';
export const APPLICATION = 'fanbox-downloader';
const MAX_PACKAGE = 5 * 1024 * 1024;
const EXPECTED_HOSTS = ['https://*.fanbox.cc/*', 'https://*.pximg.net/*', 'https://fanbox.pixiv.net/*', 'https://api.github.com/*'];
export const PATHS = ['manifest.json', 'app.html', 'app.mjs', 'background.js', 'core.mjs', 'style.css', 'update.mjs',
  'vendor/zip-native.min.js', 'vendor/zip.js-LICENSE.txt', 'icons/16.png', 'icons/48.png', 'icons/128.png'];
export const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
export function compareVersion(a,b) {
  const parse = v => { if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(v)) throw new AppError('更新版のバージョン番号が不正です。'); return v.split('.').map(Number); };
  const aa=parse(a),bb=parse(b); for(let i=0;i<4;i++) if((aa[i]||0)!==(bb[i]||0)) return Math.sign((aa[i]||0)-(bb[i]||0)); return 0;
}
export function validateIndex(index) {
  if(index?.application!==APPLICATION || !Array.isArray(index.files) || index.files.length!==PATHS.length) throw new AppError('このツール用の更新データではありません。');
  compareVersion(index.version,'0');
  const seen=new Set(); let total=0;
  for(const f of index.files) {
    if(!PATHS.includes(f.path)||seen.has(f.path)||!Number.isSafeInteger(f.size)||f.size<0||!/^[a-f0-9]{64}$/.test(f.sha256)) throw new AppError('更新ファイルの一覧が不正です。');
    seen.add(f.path); total+=f.size;
  }
  if(total>MAX_PACKAGE) throw new AppError('更新ファイルが大きすぎます。');
  return index;
}
function sameSet(a,b) { return Array.isArray(a)&&a.length===b.length&&b.every(x=>a.includes(x)); }
export async function verifyPackage(index, files, current) {
  validateIndex(index);
  if(compareVersion(index.version,current.version)<=0) throw new AppError('現在と同じか古いバージョンです。更新は不要です。');
  for(const f of index.files) {
    const data=files.get(f.path);
    if(!(data instanceof Uint8Array)||data.byteLength!==f.size||await sha256(data)!==f.sha256) throw new AppError('更新ファイルの整合性を確認できません。再取得してください。');
  }
  const manifest=JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  if(manifest.manifest_version!==3||manifest.name!==current.name||manifest.version!==index.version||
    !sameSet(manifest.permissions,['storage','declarativeNetRequestWithHostAccess'])||!sameSet(manifest.host_permissions,EXPECTED_HOSTS)||manifest.update_url||manifest.content_scripts||manifest.externally_connectable) throw new AppError('権限や用途が変わる更新です。手動で内容を確認して導入してください。');
  if(manifest.content_security_policy?.extension_pages!==current.content_security_policy?.extension_pages) throw new AppError('通信・実行ポリシーが変わる更新は手動で導入してください。');
  return {index,files,manifest};
}
function decode64(value) { const text=atob(value.replace(/\s/g,''));return Uint8Array.from(text,c=>c.charCodeAt(0)); }
export async function githubPackage(current, token='', fetcher=globalThis.fetch.bind(globalThis)) {
  const headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  if(token.trim()) headers.Authorization='Bearer '+token.trim();
  const get=async path=>{
    let r;
    try { r=await fetcher(`https://api.github.com/repos/${REPOSITORY}/${path}`,{headers,credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)}); }
    catch { throw new AppError('GitHubに接続できませんでした。'); }
    if(!r.ok) {await r.body?.cancel();throw new AppError(r.status===404||r.status===401?'非公開リポジトリには読み取り専用トークンが必要です。GitHubから取得したZIPを選ぶ方法も使えます。':`GitHubへの接続に失敗しました（HTTP ${r.status}）。`);}
    return r.json();
  };
  // Every file is pinned to one commit, even if main changes during the update.
  const commit=await get('commits/main');
  if(!/^[a-f0-9]{40}$/.test(commit.sha)) throw new AppError('GitHubの更新先を確認できません。');
  const read=async path=>{
    const item=await get('contents/extension/'+path+'?ref='+commit.sha);
    if(item.encoding!=='base64'||!Number.isSafeInteger(item.size)||item.size>MAX_PACKAGE) throw new AppError('GitHubのファイルを読み取れません。');
    return decode64(item.content);
  };
  const bytes=await read('update.json'), index=validateIndex(JSON.parse(new TextDecoder().decode(bytes)));
  if(compareVersion(index.version,current.version)<=0) return {upToDate:true,version:index.version};
  const files=new Map();
  for(const entry of index.files) files.set(entry.path,await read(entry.path));
  return verifyPackage(index,files,current);
}
export async function zipPackage(file,current) {
  if(file.size>MAX_PACKAGE) throw new AppError('更新ZIPが大きすぎます。作品ZIPではなく、ツールの更新ZIPを選んでください。');
  const z=globalThis.zip;z.configure({useWebWorkers:false});
  const reader=new z.ZipReader(new z.BlobReader(file));
  try {
    const entries=await reader.getEntries();
    const markers=entries.filter(e=>!e.directory&&/(^|\/)update\.json$/.test(e.filename));
    // Build ZIP, folder ZIP, or GitHub's "Download ZIP" source archive.
    const marker=markers.find(e=>e.filename==='update.json')||markers.find(e=>e.filename==='extension/update.json'||e.filename.endsWith('/extension/update.json'))||markers.find(e=>e.filename==='FANBOX-Chrome/update.json');
    if(!marker||marker.uncompressedSize>32768) throw new AppError('更新情報のないZIPです。v1.1.0以降の更新用ZIPを選んでください。');
    const index=validateIndex(JSON.parse(await marker.getData(new z.TextWriter(),{checkSignature:true})));
    const prefix=marker.filename.slice(0,-'update.json'.length), files=new Map();
    for(const item of index.files) {
      const matches=entries.filter(e=>e.filename===prefix+item.path);
      if(matches.length!==1||matches[0].encrypted||matches[0].uncompressedSize!==item.size) throw new AppError('更新ZIPの内容が不正です。');
      files.set(item.path,new Uint8Array(await matches[0].getData(new z.Uint8ArrayWriter(),{checkSignature:true})));
    }
    return verifyPackage(index,files,current);
  } finally {await reader.close();}
}
export async function validateFolder(handle,current) {
  let manifest;
  try {manifest=await new Disk(handle).json(['manifest.json']);}catch{}
  if(manifest?.name!==current.name||manifest?.manifest_version!==3||manifest?.version!==current.version) throw new AppError('現在読み込んでいる拡張機能のフォルダを選んでください。作品の保存先とは別です。');
}
export async function applyPackage(handle,pack,current,liveCheck=null) {
  await verifyPackage(pack.index,pack.files,current);
  await validateFolder(handle,current);
  const disk=new Disk(handle), before=new Map(), written=[];
  // Keep one recoverable backup on disk before changing installed files.
  for(const path of [...PATHS,'update.json']) {
    try {before.set(path,new Uint8Array(await(await disk.file(path.split('/'))).arrayBuffer()));}
    catch(e){if(e.name!=='NotFoundError')throw e;}
  }
  for(const [path,data] of before) await disk.write(['.fanbox-update-backup',safeName(current.version),...path.split('/')],data);
  const payload=new Map(pack.files);payload.set('update.json',new TextEncoder().encode(JSON.stringify(pack.index,null,2)+'\n'));
  const order=[...payload.keys()].filter(p=>p!=='manifest.json');order.push('manifest.json');
  try {
    for(const path of order) {written.push(path);await disk.write(path.split('/'),payload.get(path));}
    if(liveCheck) await liveCheck(pack);
  } catch(error) {
    let restored=true;
    for(const path of written.reverse()) {
      try {if(before.has(path))await disk.write(path.split('/'),before.get(path));else await(await disk.parent(path.split('/'),false)).removeEntry(path.split('/').at(-1));}catch{restored=false;}
    }
    throw new AppError(restored?'更新を完了できなかったため、元のファイルに戻しました。フォルダと書き込み権限を確認してください。':'更新を完了できませんでした。.fanbox-update-backupに元ファイルがあります。手動で復旧してください。');
  }
  return {version:pack.index.version};
}
