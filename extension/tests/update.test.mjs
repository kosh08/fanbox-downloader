import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {PATHS,sha256,compareVersion,verifyPackage,zipPackage,githubPackage,applyPackage,validateFolder} from '../update.mjs';
const require=createRequire(import.meta.url);globalThis.zip=require('../vendor/zip-native.min.js');zip.configure({useWebWorkers:false});
const manifest=JSON.parse(await fs.readFile(new URL('../manifest.json',import.meta.url),'utf8'));
const NEXT_VERSION=manifest.version.split('.').map((v,i,a)=>i===a.length-1?Number(v)+1:v).join('.');
async function pack(){
  const files=new Map(await Promise.all(PATHS.map(async p=>[p,new Uint8Array(await fs.readFile(new URL('../'+p,import.meta.url)))])));
  files.set('manifest.json',new TextEncoder().encode(JSON.stringify({...manifest,version:NEXT_VERSION})));
  const index={application:'fanbox-downloader',version:NEXT_VERSION,files:await Promise.all([...files].map(async([path,data])=>({path,size:data.length,sha256:await sha256(data)})))};
  return {files,index};
}
class Folder{
  constructor(){this.dirs=new Map();this.files=new Map();this.failOnce=null;}
  async getDirectoryHandle(name,{create}={}){if(!this.dirs.has(name)){if(!create)throw new DOMException('missing','NotFoundError');this.dirs.set(name,new Folder());}return this.dirs.get(name);}
  async removeEntry(name){this.files.delete(name);}
  async getFileHandle(name,{create}={}){
    if(!this.files.has(name)){if(!create)throw new DOMException('missing','NotFoundError');this.files.set(name,new Uint8Array());}
    return {getFile:async()=>new File([this.files.get(name)],name),createWritable:async()=>{
      if(this.failOnce===name){this.failOnce=null;throw new Error('disk full');}
      let data;return{write:async v=>{data=v;},close:async()=>{this.files.set(name,typeof data==='string'?new TextEncoder().encode(data):data);},abort:async()=>{}};
    }};
  }
}
async function installed(){const root=new Folder();root.files.set('manifest.json',new TextEncoder().encode(JSON.stringify(manifest)));root.files.set('app.mjs',new TextEncoder().encode('old source'));return root;}
test('versions compare numerically',()=>{assert.equal(compareVersion('1.10.0','1.9.9'),1);assert.equal(compareVersion('1.1','1.1.0'),0);assert.throws(()=>compareVersion('../1','1'));});
test('verified package accepts exact hashes',async()=>{const p=await pack();assert.equal((await verifyPackage(p.index,p.files,manifest)).manifest.version,NEXT_VERSION);});
test('tampered content and path traversal are rejected',async()=>{let p=await pack();p.files.set('core.mjs',new Uint8Array([1]));await assert.rejects(()=>verifyPackage(p.index,p.files,manifest),/整合性/);p=await pack();p.index.files[0].path='../manifest.json';await assert.rejects(()=>verifyPackage(p.index,p.files,manifest),/一覧/);});
test('same version and permission expansion are rejected',async()=>{let p=await pack();await assert.rejects(()=>verifyPackage({...p.index,version:manifest.version},p.files,manifest),/更新は不要/);p=await pack();const m={...manifest,version:NEXT_VERSION,permissions:[...manifest.permissions,'cookies']};const bytes=new TextEncoder().encode(JSON.stringify(m));p.files.set('manifest.json',bytes);const f=p.index.files.find(f=>f.path==='manifest.json');Object.assign(f,{size:bytes.length,sha256:await sha256(bytes)});await assert.rejects(()=>verifyPackage(p.index,p.files,manifest),/権限/);});
test('ZIP package can be read and verified',async()=>{const p=await pack();const w=new zip.ZipWriter(new zip.BlobWriter());for(const[path,data]of p.files)await w.add('extension/'+path,new zip.Uint8ArrayReader(data));await w.add('extension/update.json',new zip.TextReader(JSON.stringify(p.index)));const blob=await w.close();assert.equal((await zipPackage(blob,manifest)).index.version,NEXT_VERSION);});
test('wrong directory is rejected without any changes',async()=>{const f=new Folder();f.files.set('unrelated.txt',new Uint8Array([1]));await assert.rejects(()=>validateFolder(f,manifest),/フォルダ/);assert.equal(f.files.size,1);});
test('apply writes new manifest and keeps settings and backup',async()=>{const f=await installed();f.files.set('settings.json',new Uint8Array([123]));await applyPackage(f,await pack(),manifest);assert.equal(JSON.parse(new TextDecoder().decode(f.files.get('manifest.json'))).version,NEXT_VERSION);assert.deepEqual(f.files.get('settings.json'),new Uint8Array([123]));assert(f.dirs.get('.fanbox-update-backup').dirs.has(manifest.version));});
test('disk failure rolls back previously written files',async()=>{const f=await installed();f.failOnce='background.js';const p=await pack();await assert.rejects(()=>applyPackage(f,p,manifest),/元のファイル/);assert.equal(new TextDecoder().decode(f.files.get('app.mjs')),'old source');assert.equal(JSON.parse(new TextDecoder().decode(f.files.get('manifest.json'))).version,manifest.version);assert(!f.files.has('app.html'));});
test('wrong live folder rolls back the entire update',async()=>{const f=await installed();const p=await pack();await assert.rejects(()=>applyPackage(f,p,manifest,async()=>{throw new Error('wrong installed copy');}),/元のファイル/);assert.equal(JSON.parse(new TextDecoder().decode(f.files.get('manifest.json'))).version,manifest.version);});
test('GitHub pins one commit and never includes credentials in errors',async()=>{const requests=[],p=await pack(),sha='a'.repeat(40);const encode=x=>Buffer.from(x).toString('base64');const fetcher=async(url,options)=>{requests.push({url,options});if(url.endsWith('/commits/main'))return Response.json({sha});const filename=new URL(url).pathname.split('/extension/')[1];const data=filename==='update.json'?new TextEncoder().encode(JSON.stringify(p.index)):p.files.get(filename);return Response.json({encoding:'base64',size:data.length,content:encode(data)});};await githubPackage(manifest,'private-test-token',fetcher);assert(requests.slice(1).every(r=>r.url.endsWith('?ref='+sha)));assert(requests.every(r=>r.options.credentials==='omit'));await assert.rejects(()=>githubPackage(manifest,'private-test-token',async()=>new Response('',{status:404})),e=>!e.message.includes('private-test-token')&&e.message.includes('非公開'));});
