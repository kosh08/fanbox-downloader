import {AppError, Client, Disk, Downloader, userError} from './core.mjs';

const $ = id => document.getElementById(id);
let rules = [], storedRules = {}, rootHandle = null, busy = false, controller;
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

async function storeHandle(handle) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put(handle, 'folder');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function loadHandle() {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('settings').objectStore('settings').get('folder');
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
      await new Downloader(client, preview ? null : new Disk(rootHandle), log).run(verified, preview);
    });
  });
}

$('preview').addEventListener('click', () => start(true).catch(showError));
$('download').addEventListener('click', () => start(false).catch(showError));
$('stop').addEventListener('click', () => controller?.abort());
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });

async function init() {
  state(true);
  try {
    storedRules = (await chrome.storage.local.get('rules')).rules || {};
    rootHandle = await loadHandle(); await folderStatus();
    if (!window.showDirectoryPicker) throw new AppError('このChromeでは保存先の選択を利用できません。パソコン版Chromeを更新してください。');
  } catch (e) { showError(e); }
  finally { state(false); }
}
init();
