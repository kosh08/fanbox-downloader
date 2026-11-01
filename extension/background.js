chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const tabs = await chrome.tabs.query({url});
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, {active: true});
    await chrome.windows.update(tabs[0].windowId, {focused: true});
  } else {
    await chrome.tabs.create({url});
  }
});

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type!=='fanbox-reload-after-update'||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('app.html'))return;
  (async()=>{
    reply({ok:true});
    setTimeout(()=>chrome.runtime.reload(),300);
  })().catch(()=>reply({ok:false}));
  return true;
});

