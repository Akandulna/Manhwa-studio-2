/* Read-only chrome probe. No navigation, DOM mutation, observers, storage, fetch or page content export. */
(() => {
  const host = location.hostname;
  const provider = /^(chatgpt\.com|chat\.openai\.com)$/.test(host) ? 'chatgpt'
    : host === 'gemini.google.com' ? 'gemini' : host === 'aistudio.google.com' ? 'aistudio' : null;
  if (!provider) return null;
  const visible = e => { const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const all = s => [...document.querySelectorAll(s)].filter(visible);
  const controlsOnly = s => all(s).filter(e => !e.closest('[data-message-author-role], [data-turn-key], user-query, model-response, ms-chat-turn, section[data-testid^="conversation-turn"]'));
  const inputSelector = provider==='chatgpt' ? '#prompt-textarea, main [contenteditable="true"][role="textbox"], textarea[placeholder="Work with ChatGPT"], textarea[placeholder="Ask ChatGPT"]'
    : provider==='gemini' ? 'rich-textarea [contenteditable="true"], div[contenteditable="true"][role="textbox"]' : 'textarea[aria-label="Enter a prompt"]';
  const inputs = controlsOnly(inputSelector).filter((e,i,a) => !a.some(p => p!==e && p.contains(e)));
  const input=inputs[0];
  const buttons=controlsOnly('button, [role="button"]');
  const name = e => (e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('data-testid') || (e.innerText || '').slice(0,80)).trim().toLowerCase();
  const matches = re => buttons.filter(e => re.test(name(e)));
  const dialogs=all('[role="dialog"], [role="alertdialog"], mat-dialog-container');
  const dialogLabel=dialogs.map(name).join(' ');
  const streaming=all('[data-talvt-turn-state="in_progress"], button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop response"], ms-run-button button[aria-label="Stop"]').length>0;
  const menu = all('[role="menu"], [role="listbox"], .cdk-overlay-pane');
  const uploadChoices = controlsOnly('[role="menuitem"], .cdk-overlay-pane button, [role="menu"] button').filter(e => /upload files|upload from device|attach file/.test(name(e)));
  const modelOptions = controlsOnly('[role="menuitemradio"], [role="option"], [role="radio"]').filter(e => !!e.closest('[role="menu"], [role="listbox"], .cdk-overlay-pane'));
  const ready = !!input && !!(input.value || input.textContent || '').trim(); // Only emptiness is exported.
  const replies=[...document.querySelectorAll('[data-message-author-role="assistant"], [data-conversation-role="assistant"], model-response, ms-chat-turn')];
  const responseActions=replies.length ? [...replies.at(-1).querySelectorAll('button[aria-label="Copy"], button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]')].filter(visible) : [];
  const inferredWorkflow = uploadChoices.length ? 'upload_menu' : modelOptions.length ? 'model_menu' : ready ? 'composer_ready' : responseActions.length ? 'response_actions' : 'composer_empty';
  const workflow = typeof __websiteUiExpected !== 'undefined' && ['upload_menu','response_actions'].includes(__websiteUiExpected) ? __websiteUiExpected : inferredWorkflow;
  const send = provider==='aistudio' ? controlsOnly('ms-run-button button') : matches(/send message|send prompt|^send$|^send-button$|^submit/);
  const upload = workflow==='upload_menu' ? uploadChoices : matches(/upload.*tools|add files|upload files|upload file menu|add attachment|attach|insert images|composer-plus|^(add|attach|upload) (photos?( and| &)? )?files?( and more| & more)?$/);
  const model = workflow==='model_menu' ? menu.filter(e => !menu.some(p => p!==e && p.contains(e))) : matches(/model picker|mode picker|model-selector|select model/);
  const navigation=matches(/^new chat$|^new-chat-button$|open sidebar|close sidebar/);
  const hash = value => {let h=2166136261;for(const c of value){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');};
  const label = (id,n) => !n ? 'absent' : id==='composer' ? 'prompt' : id==='model' ? 'model' : id==='navigation' ? 'navigation'
    : id==='response_actions' ? 'copy' : /upload/.test(name(n)) ? 'upload' : /attach|insert|^add |composer-plus/.test(name(n)) ? 'attach'
    : /^run/.test(name(n)) || provider==='aistudio' && id==='send' ? 'run' : /send/.test(name(n)) ? 'send' : /submit/.test(name(n)) ? 'submit' : 'unrecognized';
  const quantize = n => Math.max(0,Math.min(8,Math.round(n*8)));
  const sample=(id,nodes) => {
    const n=nodes[0],b=n?.getBoundingClientRect(),css=n?getComputedStyle(n):null;
    const token=label(id,n);
    // No arbitrary labels, SVG paths, HTML, URLs or conversation text leave the page.
    const icon=n?.querySelector('svg, mat-icon, [data-mat-icon-name]');
    return {id,count:Math.min(2,nodes.length),label:token,signature:hash(token),icon:hash(icon ? [icon.tagName,icon.getAttribute('viewBox')||'',...Array.from(icon.querySelectorAll('path')).map(p=>p.getAttribute('d')||''),icon.getAttribute('data-mat-icon-name')||''].join(':') : ''),
      location:b?[quantize(b.x/innerWidth),quantize(b.y/innerHeight),quantize(b.width/innerWidth),quantize(b.height/innerHeight)]:[0,0,0,0],
      style:hash(css?[css.borderRadius,css.fontSize,css.fontWeight,css.color,css.backgroundColor].join(':'):'')};
  };
  let reason=document.readyState==='loading'?'loading':streaming?'streaming':/sign.?in|log.?in|session/.test(dialogLabel)?'session_overlay'
    :/quota|limit|capacity/.test(dialogLabel)?'quota_overlay':dialogs.length && !menu.length?'dialog':typeof visualViewport!=='undefined'&&visualViewport.height<innerHeight*.75?'keyboard':'stable';
  if ((workflow==='upload_menu' && !menu.length) || (workflow==='response_actions' && !replies.length)) reason='unsupported';
  if (navigation.some(e => e.getAttribute('aria-expanded')==='true')) reason='dialog';
  if (!input && !menu.length && !dialogs.length && !upload.length && !navigation.length && !model.length && reason==='stable') reason='unsupported';
  const width=Math.max(80,Math.min(9920,Math.round(innerWidth/80)*80)),height=Math.max(80,Math.min(9920,Math.round(innerHeight/80)*80));
  const locale=/^[a-zA-Z-]{2,24}$/.test(document.documentElement.lang||'')?document.documentElement.lang:'und';
  const theme=document.documentElement.classList.contains('dark')||document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light';
  return {provider,workflow,variant:{viewport:`${width}x${height}`,locale,theme,profileVariant:'unknown'},reason,
    controls:[sample('composer',inputs),sample('send',ready?send:[]),sample('upload',upload),sample('model',model),sample('navigation',navigation),sample('response_actions',responseActions)]};
})()
