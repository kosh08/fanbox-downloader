export class AppError extends Error {}
export const API = 'https://api.fanbox.cc/';
export const checkStop = signal => { if (signal?.aborted) throw new DOMException('停止しました。次回実行で再開できます。', 'AbortError'); };

export function creatorIdFromInput(value) {
  const input=String(value).trim();let id=input.replace(/^@/,'');
  if(input.includes('://')){
    let url;try{url=new URL(input);}catch{throw new AppError('FANBOXのクリエイターURLまたはIDを入力してください。');}
    if(url.protocol!=='https:'||url.username||url.password||url.port)throw new AppError('httpsのFANBOXクリエイターURLを入力してください。');
    if(['www.fanbox.cc','fanbox.cc'].includes(url.hostname))id=url.pathname.match(/^\/@([^/]+)(?:\/|$)/)?.[1]||'';
    else id=url.hostname.match(/^([a-z0-9_-]+)\.fanbox\.cc$/i)?.[1]||'';
  }
  if(!/^[a-z0-9_-]{1,64}$/i.test(id)||['www','api','downloads'].includes(id.toLowerCase()))throw new AppError('FANBOXのクリエイターURLまたはIDを入力してください。例：https://creator-id.fanbox.cc/');
  return id.toLowerCase();
}

export function creatorRules(active,stored={}) {
  const make=(creator,old)=>({...creator,manual:old.manual===true,enabled:old.enabled??true,grouped:old.grouped??true,
    includeFree:creator.supportedFee===0?true:(old.includeFree??false),mode:old.mode==='exact'?'exact':'max',
    amount:Math.max(0,Math.min(Number.isFinite(old.amount)?old.amount:creator.supportedFee,creator.supportedFee))});
  const result=new Map(active.map(c=>[c.id,make(c,stored[c.id]||{})]));
  for(const old of Object.values(stored))if(old.manual===true&&old.id&&!result.has(old.id))result.set(old.id,make({id:old.id,name:old.name||old.id,supportedFee:0},old));
  return [...result.values()];
}

export function unwrapBody(body, endpoint) {
  const fields = {'plan.listSupporting': ['plans', 'items'], 'post.paginateCreator': ['pageUrls'], 'post.listCreator': ['posts', 'items']};
  if (endpoint === 'creator.get') {
    const creator=body?.creator??body;
    if(creator&&typeof creator==='object'&&!Array.isArray(creator)&&typeof creator.creatorId==='string')return creator;
  } else if (endpoint === 'post.info') {
    if (body === null) return null;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (Object.hasOwn(body, 'post')) {
        if (body.post === null || (body.post && typeof body.post === 'object' && !Array.isArray(body.post) && body.post.id != null)) return body.post;
      } else if (body.id != null) return body;
    }
  } else if (fields[endpoint]) {
    if (Array.isArray(body)) return body;
    for (const field of fields[endpoint]) {
      if (body && Object.hasOwn(body, field)) {
        if (Array.isArray(body[field])) return body[field];
        if (body[field] === null) return [];
      }
    }
    if (body === null) throw new AppError('FANBOXからログイン済みのデータが返されませんでした。同じChromeプロフィールでFANBOXにログインし直してください。');
  } else return body;
  // Only structural field names are included; never log response values or session data.
  const shape = body && typeof body === 'object' ? Object.keys(body).slice(0, 10).map(k => k.replace(/[^a-zA-Z0-9_]/g, '?').slice(0, 32)).join(', ') : typeof body;
  throw new AppError(`応答形式を読み取れません（${endpoint}／項目：${shape || 'なし'}）。このエラー文をお知らせください。`);
}

export function safeName(value, limit = 64) {
  let name = [...String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '')].slice(0, limit).join('').replace(/[. ]+$/g, '') || '_';
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(name)) name = '_' + name;
  return name;
}

export function checkedURL(value, api = false) {
  const url = new URL(value.startsWith('//') ? 'https:' + value : value);
  const host = url.hostname.toLowerCase();
  const allowed = api ? host === 'api.fanbox.cc' : ['fanbox.cc', 'pximg.net', 'fanbox.pixiv.net'].some(d => host === d || host.endsWith('.' + d));
  if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port) throw new AppError('FANBOX以外の保存先URLは取得しません。');
  return url.href;
}

export function feeMatches(fee, rule) {
  if (fee === 0) return Boolean(rule.includeFree);
  if (fee < 0 || fee > Number(rule.supportedFee)) return false;
  return rule.mode === 'exact' ? fee === Number(rule.amount) : fee <= Number(rule.amount);
}

export function baseName(rule, post) {
  const date = new Date(post.publishedDatetime);
  if (Number.isNaN(date.getTime())) throw new AppError('投稿日時を読み取れません。');
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Tokyo', year: '2-digit', month: '2-digit', day: '2-digit'}).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  const title = safeName(String(post.title || '無題').replace(/\s+/g, ' ').trim(), 48);
  return `${safeName(rule.name, 40)}_${get('year')}${get('month')}${get('day')}投稿分_${title}_p${safeName(post.id, 24)}`;
}

export function collectAssets(post) {
  const body = post.body || {}, assets = [], seen = new Set();
  const add = (item, key) => {
    const url = item?.[key];
    if (!url || seen.has(url)) return;
    seen.add(url);
    const ext = String(item.extension || new URL(url).pathname.split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'bin';
    assets.push({url, ext, name: item.name || ''});
  };
  for (const item of body.images || []) add(item, 'originalUrl');
  for (const item of body.files || []) add(item, 'url');
  for (const [mapName, idName, key] of [['imageMap', 'imageId', 'originalUrl'], ['fileMap', 'fileId', 'url']]) {
    const map = body[mapName] || {};
    const ids = new Set((body.blocks || []).filter(b => b[idName]).map(b => String(b[idName])));
    for (const id of Object.keys(map)) ids.add(id);
    for (const id of ids) add(map[id], key);
  }
  if (body.html && typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(body.html, 'text/html');
    for (const element of doc.querySelectorAll('[data-src-original],a[href],video[src],audio[src],source[src]')) {
      const source = element.getAttribute('data-src-original') || element.getAttribute('href') || element.getAttribute('src');
      let url;try{url=new URL(source,'https://www.fanbox.cc/').href;}catch{continue;}
      if (element.matches('video,audio,source')) {
        try{checkedURL(url);}catch{continue;}
        add({url},'url');
      } else if (element.hasAttribute('data-src-original') || /downloads\.fanbox\.cc\/|fanbox\.pixiv\.net\/images\/entry/.test(url)) add({url}, 'url');
    }
  }
  return assets;
}

export function assetKind(ext) {
  if(['mp4','webm','mov','m4v','avi','mkv','mpeg','mpg'].includes(ext))return '動画';
  if(['mp3','m4a','wav','ogg','oga','opus','flac','aac','aiff','wma'].includes(ext))return '音声';
  if(['jpg','jpeg','png','gif','webp','avif','bmp','tif','tiff'].includes(ext))return '画像';
  return '添付ファイル';
}

export function postText(rule, post) {
  const body = post.body || {};
  const lines = [post.title || '', `https://www.fanbox.cc/@${rule.id}/posts/${post.id}`, post.publishedDatetime, '', body.text || ''];
  for (const block of body.blocks || []) {
    if (block.text) lines.push(block.text);
    for (const link of block.links || []) lines.push(link.url || '');
  }
  if (body.html && typeof DOMParser !== 'undefined') {
    const doc=new DOMParser().parseFromString(body.html,'text/html');lines.push(doc.body.textContent);
    for(const el of doc.querySelectorAll('a[href],video[src],audio[src],source[src]'))lines.push(el.getAttribute('href')||el.getAttribute('src'));
  }
  const embeds = Object.fromEntries(['video', 'embedMap', 'urlEmbedMap'].filter(k => body[k]).map(k => [k, body[k]]));
  if (Object.keys(embeds).length) lines.push('外部埋め込み（自動取得対象外）', JSON.stringify(embeds, null, 2));
  return '\ufeff' + lines.join('\n');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    checkStop(signal);
    const abort = () => { clearTimeout(timer); reject(new DOMException('停止しました。', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, {once: true});
  });
}

export class Client {
  constructor(signal, fetcher = globalThis.fetch.bind(globalThis)) { this.signal = signal; this.fetcher = fetcher; this.last = 0; }
  async response(url, api = false) {
    url = checkedURL(url, api);
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(Math.max(0, 1200 - (Date.now() - this.last)), this.signal);
      this.last = Date.now();
      let response;
      try {
        response = await this.fetcher(url, {credentials: 'include', cache: 'no-store', redirect: 'error',
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(api ? 45000 : 1800000)]), headers: {Accept: api ? 'application/json' : '*/*'}});
      } catch (error) {
        checkStop(this.signal);
        if (attempt === 3) throw new AppError('通信に失敗しました。FANBOXへのログイン状態と接続を確認してください。');
        await sleep(3000 * 2 ** attempt, this.signal);
        continue;
      }
      if (response.ok) return response;
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new AppError(`HTTP ${response.status}：FANBOXにログインし直してください。閲覧権限やサイト側の制限によっても取得できない場合があります。`);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) throw new AppError(`HTTP ${response.status}：取得できませんでした。`);
      const wait = response.headers.get('Retry-After');
      await sleep(/^\d+$/.test(wait || '') ? Math.min(Number(wait), 300) * 1000 : 3000 * 2 ** attempt, this.signal);
    }
  }
  async api(path) {
    const response = await this.response(path.startsWith('https:') || path.startsWith('//') ? path : API + path, true);
    let data;
    try { data = await response.json(); } catch { checkStop(this.signal); throw new AppError('FANBOXの応答を読めません。ブラウザでログイン状態を確認してください。'); }
    if (!data || !('body' in data) || data.error) throw new AppError('FANBOXの応答形式が変わった可能性があります。');
    return unwrapBody(data.body, new URL(path.startsWith('https:') || path.startsWith('//') ? path.startsWith('//') ? 'https:' + path : path : API + path).pathname.slice(1));
  }
  async supporting() {
    const body = await this.api('plan.listSupporting');
    const entries = Array.isArray(body) ? body : body?.items;
    if (!Array.isArray(entries)) throw new AppError('支援一覧を読み取れません。');
    const result = new Map();
    for (const entry of entries) {
      const p = entry.plan || entry, creator = p.creator || entry.creator || {};
      const id = p.creatorId || creator.creatorId, user = p.user || creator.user || entry.user || {};
      if (!id || !Number.isFinite(Number(p.fee))) throw new AppError('支援プランを読み取れません。');
      const rule = {id: String(id), name: user.name || String(id), supportedFee: Number(p.fee)};
      if (!result.has(id) || result.get(id).supportedFee < rule.supportedFee) result.set(id, rule);
    }
    return [...result.values()];
  }
  async creator(value) {
    const id=creatorIdFromInput(value);
    const creator=await this.api('creator.get?'+new URLSearchParams({creatorId:id}));
    if(creator.creatorId.toLowerCase()!==id)throw new AppError('指定したクリエイターを確認できませんでした。');
    return {id:creatorIdFromInput(creator.creatorId),name:creator.user?.name||id,supportedFee:0};
  }
  async *posts(id) {
    const pages = await this.api('post.paginateCreator?' + new URLSearchParams({creatorId: id}));
    if (!Array.isArray(pages)) throw new AppError('投稿一覧を読み取れません。');
    const seen = new Set();
    for (const page of pages) {
      checkStop(this.signal);
      const data = await this.api(page), items = Array.isArray(data) ? data : data?.items;
      if (!Array.isArray(items)) throw new AppError('投稿一覧のページを読み取れません。');
      for (const post of items) if (!seen.has(String(post.id))) { seen.add(String(post.id)); yield post; }
    }
  }
}

export class Disk {
  constructor(root) { this.root = root; }
  async parent(parts, create = true) {
    let folder = this.root;
    if (parts.some(p => !p || p === '.' || p === '..' || /[/\\]/.test(p))) throw new AppError('保存パスが不正です。');
    for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, {create});
    return folder;
  }
  async handle(parts, create = true) { return (await this.parent(parts, create)).getFileHandle(parts.at(-1), {create}); }
  async file(parts) { return (await this.handle(parts, false)).getFile(); }
  async write(parts, input, signal) {
    checkStop(signal);
    const handle = await this.handle(parts), writable = await handle.createWritable();
    try {
      if (input instanceof ReadableStream) await input.pipeTo(writable, {signal});
      else { await writable.write(input); checkStop(signal); await writable.close(); }
    } catch (e) { try { await writable.abort(); } catch {} throw e; }
    return this.record(parts);
  }
  async record(parts) { const file = await this.file(parts); return {parts, size: file.size, modified: file.lastModified}; }
  async valid(records, signal) {
    if (!Array.isArray(records) || !records.length) return false;
    for (const r of records) {
      checkStop(signal);
      try { const f = await this.file(r.parts); if (f.size !== r.size || f.lastModified !== r.modified) return false; }
      catch (e) { if (e.name === 'NotFoundError') return false; throw e; }
    }
    return true;
  }
  async existsAny(records, signal) {
    for (const r of records || []) {
      checkStop(signal);
      try { await this.file(r.parts); return true; }
      catch(e) { if(e.name !== 'NotFoundError') throw e; }
    }
    return false;
  }
  async json(parts) {
    try { return JSON.parse(await (await this.file(parts)).text()); }
    catch (e) { if (e.name === 'NotFoundError' || e instanceof SyntaxError) return null; throw e; }
  }
}

export function zipPaths(entries, prefix, grouped) {
  if (entries.length > 100000) throw new AppError('ZIPの項目数が10万件を超えます。元ZIPを残します。');
  let size = 0;
  const used = new Set(), result = [];
  for (const [index, entry] of entries.entries()) {
    const raw = entry.filename.replace(/\\/g, '/'), parts = raw.split('/').filter(Boolean);
    if (raw.startsWith('/') || parts.some(p => p === '.' || p === '..' || p.includes(':')) || entry.symlink || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new AppError('危険なパスを含むZIPは展開しません。元ZIPを残します。');
    if (entry.encrypted) throw new AppError('パスワード付きZIPは自動展開できません。元ZIPを残します。');
    if (entry.directory) continue;
    if (!parts.length || parts.length > 32) throw new AppError('ZIP内部の階層を保存できません。');
    size += entry.uncompressedSize;
    if (!Number.isSafeInteger(size) || size > 20 * 1024 ** 3 || entry.uncompressedSize > Math.max(entry.compressedSize, 1) * 1000) throw new AppError('ZIPの展開サイズ・圧縮率の上限を超えました。元ZIPを残します。');
    const cleaned = parts.map(p => safeName(p, 60));
    const leaf = `${prefix}_z${String(index + 1).padStart(4, '0')}_${cleaned.at(-1)}`;
    const path = grouped ? [prefix + '_展開', ...cleaned.slice(0, -1), leaf] : [leaf];
    const key = path.join('/').toLowerCase();
    if (used.has(key)) throw new AppError('ZIP内の保存名が重複しています。元ZIPを残します。');
    used.add(key);
    result.push({entry, path});
  }
  return result;
}

export async function unzip(disk, archive, destination, prefix, grouped, signal) {
  const zip = globalThis.zip;
  zip.configure({useWebWorkers: false});
  const reader = new zip.ZipReader(new zip.BlobReader(await disk.file(archive)), {filenameEncoding: 'shift_jis'});
  try {
    const plan = zipPaths(await reader.getEntries(), prefix, grouped), records = [];
    for (const {entry, path} of plan) {
      checkStop(signal);
      const parts = [...destination, ...path], handle = await disk.handle(parts), writable = await handle.createWritable();
      try { await entry.getData(writable, {checkSignature: true, signal}); }
      catch (error) { try { await writable.abort(); } catch {} throw error; }
      records.push(await disk.record(parts));
    }
    return records;
  } finally { await reader.close(); }
}

export function userError(e) {
  if (e?.name === 'AbortError') return '停止しました。未完了の投稿は次回に取り直します。';
  if (e instanceof AppError) return e.message;
  if (['NotAllowedError', 'SecurityError'].includes(e?.name)) return '保存先フォルダへのアクセスを許可してください。「保存先を選ぶ」から選び直せます。';
  if (e?.name === 'QuotaExceededError') return '保存先の空き容量が不足しています。';
  return '保存・ZIP展開に失敗しました。元ZIP、保存先の空き容量、書き込み権限を確認してください。';
}

export class Downloader {
  constructor(client, disk, log = () => {}, options = {}) { this.client = client; this.disk = disk; this.log = log; this.signal = client.signal; this.options=options;this.onExisting = options.onExisting || (async () => ({action:'skip'})); this.existingAction = null; this.count = {saved: 0, skipped: 0, filtered: 0, restricted: 0, errors: 0}; }
  async notify(name,value) {
    try{await this.options[name]?.(value);}
    catch{this.log('失敗履歴の保存に失敗しました。このタブを閉じる前にログを保存してください。');}
  }
  async confirmExisting(rule, item, namingChanged) {
    checkStop(this.signal);
    const answer = this.existingAction ? {action:this.existingAction} : await this.onExisting({rule,item,namingChanged});
    checkStop(this.signal);
    if(answer?.action === 'cancel') throw new DOMException('保存を中止しました。', 'AbortError');
    if(!['skip','redownload'].includes(answer?.action)) throw new AppError('保存済み投稿への選択を確認できません。');
    if(answer.applyAll) this.existingAction = answer.action;
    if(answer.action === 'skip') {this.count.skipped++;this.log(`保存済みをスキップ：${item.id}`);return false;}
    return true;
  }
  async save(rule, item) {
    const folder = `${safeName(rule.name, 40)}__${safeName(rule.id)}`;
    const statePath = ['.fanbox-state', safeName(rule.id), safeName(item.id) + '.json'];
    const policy = JSON.stringify({grouped: rule.grouped, folder, version: 2});
    const old = await this.disk.json(statePath);
    if(this.options.onlyUnfinished && old?.files?.length && await this.disk.valid(old.files,this.signal)) {
      this.count.skipped++;this.log(`保存完了を確認・スキップ：${item.id}`);
      await this.notify('onSuccess',{rule,item});return;
    }
    const existing = old?.files?.length && await this.disk.existsAny(old.files, this.signal);
    if(!this.options.onlyUnfinished && existing && !await this.confirmExisting(rule,item,old.policy !== policy || old.base !== baseName(rule,item))) return;
    const post = await this.client.api('post.info?' + new URLSearchParams({postId: item.id}));
    if (post?.isRestricted || post?.body == null) { this.count.restricted++; this.log(`閲覧不可：${item.id}`); return; }
    if (!feeMatches(Number(post.feeRequired || 0), rule)) { this.count.filtered++; return; }
    const base = baseName(rule, post), destination = rule.grouped ? [folder, base] : [folder], records = [];
    const assets = collectAssets(post);
    const targets = assets.map((asset,index) => {
      const prefix = `${base}_${String(index + 1).padStart(3, '0')}`;
      const original = asset.name ? '_' + safeName(asset.name.replace(/\.[^.]+$/, ''), 35) : '';
      const parts = [...destination, `${prefix}${original}.${asset.ext}`];
      return {...asset,prefix,parts};
    });
    if(!this.options.onlyUnfinished && !existing && await this.disk.existsAny([...targets.map(a=>({parts:a.parts})),{parts:[...destination,`${base}_本文.txt`]}],this.signal)) {
      if(!await this.confirmExisting(rule,post,false)) return;
    }
    for (const asset of targets) {
      checkStop(this.signal);
      const {prefix,parts}=asset;
      this.log(`${assetKind(asset.ext)}を保存中：${parts.at(-1)}`);
      const response = await this.client.response(asset.url);
      if (/text\/html/i.test(response.headers.get('Content-Type') || '')) { await response.body?.cancel(); throw new AppError('ファイルの代わりにログイン画面が返されました。'); }
      records.push(await this.disk.write(parts, response.body, this.signal));
      const file = await this.disk.file(parts), signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (asset.ext === 'zip' || (signature[0] === 80 && signature[1] === 75 && [3, 5, 7].includes(signature[2]))) {
        this.log(`ZIP展開中：${parts.at(-1)}`);
        records.push(...await unzip(this.disk, parts, destination, prefix, rule.grouped, this.signal));
      }
    }
    records.push(await this.disk.write([...destination, `${base}_本文.txt`], postText(rule, post), this.signal));
    await this.disk.write(statePath, JSON.stringify({policy, base, updated: post.updatedDatetime ?? item.updatedDatetime, files: records}), this.signal);
    this.count.saved++;
    this.log(`投稿保存完了：${base}`);
    await this.notify('onSuccess',{rule,item});
  }
  async run(rules, preview = false) {
    this.existingAction=null;
    for (const rule of rules.filter(r => r.enabled)) {
      if(this.options.retryFilter && !this.options.retryFilter.has(rule.id))continue;
      checkStop(this.signal);
      this.log(rule.supportedFee===0?`クリエイター：${rule.name} ／ 無料投稿のみ`:`支援先：${rule.name} ／ ${rule.supportedFee}円で支援`);
      try {
        for await (const item of this.client.posts(rule.id)) {
          checkStop(this.signal);
          const targets=this.options.retryFilter?.get(rule.id);
          if(targets && !targets.has(String(item.id)))continue;
          if (!feeMatches(Number(item.feeRequired || 0), rule)) { this.count.filtered++; continue; }
          if (item.isRestricted) { this.count.restricted++; continue; }
          if (preview) { this.count.saved++; this.log(`対象候補：${item.id} ／ ${item.title || ''} ／ ${item.feeRequired}円`); continue; }
          try { await this.save(rule, item); }
          catch (error) { if(error.name==='AbortError')throw error;checkStop(this.signal); this.count.errors++; this.log(`投稿 ${item.id}：${userError(error)}`);await this.notify('onFailure',{rule,item,error:userError(error)}); }
        }
        if(!preview)await this.notify('onCreatorSuccess',{rule});
      } catch (error) { if(error.name==='AbortError')throw error;checkStop(this.signal); this.count.errors++; this.log(`${rule.name}：${userError(error)}`);if(!preview)await this.notify('onFailure',{rule,item:null,error:userError(error)}); }
    }
    const c = this.count;
    this.log(`終了：${preview ? '候補' : '保存'} ${c.saved} ／ 保存済み ${c.skipped} ／ 金額対象外 ${c.filtered} ／ 閲覧不可 ${c.restricted} ／ 失敗 ${c.errors}`);
    return c;
  }
}

export function failureIdsFromLog(text) {
  const ids=new Set();
  for(const match of String(text).matchAll(/^\s*投稿\s+(\d+)\s*[：:]/gm)){
    ids.add(match[1]);if(ids.size>20000)throw new AppError('失敗投稿が2万件を超えます。ログを分けて取り込んでください。');
  }
  return [...ids];
}
