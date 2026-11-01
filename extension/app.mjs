import {AppError, Client, Disk, Downloader, userError} from './core.mjs';
import {githubPackage, zipPackage, applyPackage, validateFolder, sha256} from './update.mjs';

const $ = id => document.getElementById(id);
let rules = [], storedRules = {}, rootHandle = null, updateHandle = null, busy = false, controller;
const RULE_ID = 73001;
const showError = e => log(userError(e));

function log(text) {
  $('status').textContent = text;
  const line = document.createElement('div');
  line.textContent = text;
  $('log').append(line);
  if ($('log').childElementCount > 600) $('log').firstElementChild.remove();
  $('log').scrollTop = $('log').scrollHeight;
}

function state(value) {
  busy = value;
  for (const element of document.querySelectorAll('button,input,select')) element.disabled = value;
  $('stop').disabled = !value;
  $('dot').classList.toggle('running', value);
}

async function saveRules() {
  storedRules = {...storedRules, ...Object.fromEntries(rules.map(r => [r.id, r]))};
  await chrome.storage.local.set({rules: storedRules});
}

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function render() {
  $('creators').replaceChildren();
  $('empty').hidden = rules.length > 0;
  $('creator-count').textContent = `${rules.length} 件`;
  for (const rule of rules) {
    const row = node('tr');
    const cell = () => { const td = node('td'); row.append(td); return td; };
    function checkbox(key) {
      const input = node('input'); input.type = 'checkbox'; input.checked = rule[key];
      input.setAttribute('aria-label', `${rule.name}：${{enabled: '取得する', grouped: '投稿フォルダを作る', includeFree: '無料投稿を含める'}[key]}`);
      input.addEventListener('change', () => { rule[key] = input.checked; saveRules().catch(showError); });
      return input;
    }
    cell().append(checkbox('enabled'));
    const name = cell(); name.append(node('strong', rule.name), node('small', '@' + rule.id));
    cell().textContent = `${rule.supportedFee.toLocaleString()} 円`;
    const amountCell = cell(), amount = node('input'), mode = node('select');
    amount.type = 'number'; amount.min = 0; amount.max = rule.supportedFee; amount.step = 1; amount.value = rule.amount;
    amount.setAttribute('aria-label', `${rule.name}：取得金額`);
    for (const [value, label] of [['max', '円 以下'], ['exact', '円 と一致']]) { const option = node('option', label); option.value = value; mode.append(option); }
    mode.value = rule.mode; mode.setAttribute('aria-label', `${rule.name}：金額条件`);
    amount.addEventListener('change', () => {
      if (!amount.validity.valid || !Number.isInteger(Number(amount.value)) || amount.value === '') {
        log(`取得金額は0〜${rule.supportedFee}円の整数にしてください。`); amount.value = rule.amount; return;
      }
      rule.amount = Number(amount.value); saveRules().catch(showError);
    });
    mode.addEventListener('change', () => { rule.mode = mode.value; saveRules().catch(showError); });
    amountCell.append(amount, mode);
    const groupLabel = node('label', undefined, 'group-label'); groupLabel.append(checkbox('grouped'), node('span', '作る')); cell().append(groupLabel);
    const freeLabel = node('label', undefined, 'group-label'); freeLabel.append(checkbox('includeFree'), node('span', '含める')); cell().append(freeLabel);
    $('creators').append(row);
  }
}

async function ensureHeaders() {
  // Limited to requests initiated by this extension, never the user's normal tabs.
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [RULE_ID], addRules: [{
    id: RULE_ID, priority: 1,
    action: {type: 'modifyHeaders', requestHeaders: [
      {header: 'Origin', operation: 'set', value: 'https://www.fanbox.cc'},
      {header: 'Referer', operation: 'set', value: 'https://www.fanbox.cc/'}]},
    condition: {initiatorDomains: [chrome.runtime.id], requestDomains: ['fanbox.cc', 'pximg.net', 'fanbox.pixiv.net'], resourceTypes: ['xmlhttprequest']}
  }]});
}

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('fanbox-local', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeHandle(handle,key='folder') {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put(handle, key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function loadHandle(key='folder') {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('settings').objectStore('settings').get(key);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function folderStatus() {
  if (!rootHandle) return;
  const allowed = await rootHandle.queryPermission({mode: 'readwrite'});
  $('folder-name').textContent = `${rootHandle.name}${allowed === 'granted' ? ' に保存します' : '（保存時にアクセス許可が必要です）'}`;
}

async function task(fn) {
  if (busy) return;
  state(true); controller = new AbortController();
  try { await ensureHeaders(); await fn(new Client(controller.signal)); }
  catch (e) { showError(e); }
  finally { state(false); }
}

$('folder').addEventListener('click', async () => {
  try {
    rootHandle = await window.showDirectoryPicker({id: 'fanbox-archive', mode: 'readwrite'});
    await storeHandle(rootHandle); await folderStatus();
  } catch (e) { if (e.name !== 'AbortError') showError(e); }
});

$('connect').addEventListener('click', () => task(async client => {
  log('現在の支援先と支援額を確認中…');
  const active = await client.supporting();
  rules = active.map(creator => {
    const old = storedRules[creator.id] || {};
    return {...creator, enabled: old.enabled ?? true, grouped: old.grouped ?? true, includeFree: old.includeFree ?? false,
      mode: old.mode === 'exact' ? 'exact' : 'max', amount: Math.max(0, Math.min(Number.isFinite(old.amount) ? old.amount : creator.supportedFee, creator.supportedFee))};
  });
  render(); await saveRules();
  $('connection').textContent = `ログイン確認済み・支援先 ${rules.length} 件`;
  log(`${rules.length}件の支援先を読み込みました。`);
}));

async function start(preview) {
  if (busy) return;
  if (!rules.some(r => r.enabled)) { log('先に支援先を読み込み、取得する支援先を選んでください。'); return; }
  if (!preview) {
    if (!rootHandle) { log('保存先フォルダを選んでください。'); return; }
    try { if (await rootHandle.requestPermission({mode: 'readwrite'}) !== 'granted') { log('保存先へのアクセスを許可してください。'); return; } }
    catch (e) { showError(e); return; }
  }
  await task(async client => {
    await navigator.locks.request('fanbox-archive-run', {ifAvailable: true}, async lock => {
      if (!lock) throw new AppError('別の管理画面で処理中です。そちらの完了を待ってください。');
      await saveRules();
      log(preview ? '保存せずに投稿候補を確認します…' : '現在の支援状況を確認して保存を開始します…');
      const active = new Map((await client.supporting()).map(r => [r.id, r]));
      const verified = [];
      for (const rule of rules.filter(r => r.enabled)) {
        if (!active.has(rule.id)) { log(`支援終了のため除外：${rule.name}`); continue; }
        const fee = active.get(rule.id).supportedFee;
        verified.push({...rule, supportedFee: fee, amount: Math.min(rule.amount, fee)});
      }
      await new Downloader(client, preview ? null : new Disk(rootHandle), log, {onExisting: askExisting}).run(verified, preview);
    });
  });
}

function askExisting({rule,item,namingChanged}) {
  const dialog=$('existing-dialog');
  $('existing-post').textContent=`${rule.name} ／ ${item.title || '無題'}（投稿 ${item.id}）`;
  $('existing-note').textContent=namingChanged ? '再ダウンロードするとタイトル付きの新しい名前で保存します。以前の名前のファイルは残ります。' : '再ダウンロードすると同じ保存名のファイルを上書きします。';
  $('existing-all').checked=false;
  for(const control of dialog.querySelectorAll('button,input'))control.disabled=false;
  return new Promise(resolve=>{
    let finished=false;
    const finish=action=>{
      if(finished)return;finished=true;
      dialog.removeEventListener('click',click);dialog.removeEventListener('cancel',cancel);
      controller.signal.removeEventListener('abort',abort);
      const applyAll=$('existing-all').checked;
      dialog.close();resolve({action,applyAll});
    };
    const click=e=>{const action=e.target.closest('[data-existing-action]')?.dataset.existingAction;if(action)finish(action);};
    const cancel=e=>{e.preventDefault();finish('cancel');};
    const abort=()=>finish('cancel');
    dialog.addEventListener('click',click);dialog.addEventListener('cancel',cancel);
    controller.signal.addEventListener('abort',abort,{once:true});
    dialog.showModal();
    if(controller.signal.aborted)abort();
  });
}

$('preview').addEventListener('click', () => start(true).catch(showError));
$('download').addEventListener('click', () => start(false).catch(showError));
$('stop').addEventListener('click', () => controller?.abort());
$('update-folder').addEventListener('click',async()=>{
  try {
    const handle=await showDirectoryPicker({id:'fanbox-extension-update',mode:'readwrite'});
    await validateFolder(handle,chrome.runtime.getManifest());
    updateHandle=handle;await storeHandle(handle,'update-folder');$('update-folder-name').textContent=handle.name;
    $('update-status').textContent='更新先を設定しました。次回から更新ZIPを選ぶだけで適用できます。';
  }catch(e){if(e.name!=='AbortError')showError(e);}
});

async function updateTool(source) {
  if(busy)return;
  if(!updateHandle){log('先に「拡張機能のフォルダを選ぶ」で更新先を設定してください。');return;}
  let file;
  try {
    if(await updateHandle.requestPermission({mode:'readwrite'})!=='granted')throw new AppError('更新先の読み書きを許可してください。');
    if(source==='zip') {
      const [handle]=await showOpenFilePicker({types:[{description:'更新ZIP',accept:{'application/zip':['.zip']}}],multiple:false});
      file=await handle.getFile();
    }
  }catch(e){if(e.name!=='AbortError')showError(e);return;}
  state(true);$('stop').disabled=true;
  try {
    await navigator.locks.request('fanbox-archive-run',{ifAvailable:true},async lock=>{
      if(!lock)throw new AppError('別の管理画面で作品を保存しています。完了後に更新してください。');
      $('update-status').textContent='更新ファイルを確認中…';
      const current=chrome.runtime.getManifest();
      const pack=source==='zip'?await zipPackage(file,current):await githubPackage(current,$('github-token').value);
      $('github-token').value='';
      if(pack.upToDate){$('update-status').textContent='現在のバージョンが最新です。';return;}
      $('update-status').textContent=`v${pack.index.version} を適用中… タブを閉じないでください。`;
      await applyPackage(updateHandle,pack,current,async expected=>{
        // Reject a different copy of the extension folder before reloading Chrome.
        const live=await fetch(chrome.runtime.getURL('manifest.json')+'?check='+Date.now(),{cache:'no-store'});
        const bytes=new Uint8Array(await live.arrayBuffer());
        const target=expected.index.files.find(f=>f.path==='manifest.json');
        if(await sha256(bytes)!==target.sha256)throw new AppError('実際に読み込んでいるフォルダと違います。');
      });
      $('update-status').textContent='更新しました。画面が閉じたら、拡張機能のボタンから開き直してください。';
      await chrome.runtime.sendMessage({type:'fanbox-reload-after-update'});
    });
  }catch(e){$('github-token').value='';$('update-status').textContent=userError(e);log(userError(e));}
  finally{state(false);}
}
$('update-zip').addEventListener('click',()=>updateTool('zip').catch(showError));
$('update-github').addEventListener('click',()=>updateTool('github').catch(showError));
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });

async function init() {
  state(true);
  try {
    storedRules = (await chrome.storage.local.get('rules')).rules || {};
    rootHandle = await loadHandle(); await folderStatus();
    updateHandle=await loadHandle('update-folder');
    if(updateHandle)$('update-folder-name').textContent=updateHandle.name;
    $('installed-version').textContent='v'+chrome.runtime.getManifest().version;
    if (!window.showDirectoryPicker) throw new AppError('このChromeでは保存先の選択を利用できません。パソコン版Chromeを更新してください。');
  } catch (e) { showError(e); }
  finally { state(false); }
}
init();
