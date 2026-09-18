/** Shared navigation for the run inspector and authoring library. */
export function withAppShell(
  html: string,
  active: "run" | "library" | "knowledge",
) {
  const link = (key: string, href: string, label: string) =>
    `<a href="${href}" ${active === key ? 'aria-current="page"' : ""}>${label}</a>`;
  const header = `<header class="app-header"><a class="app-brand" href="/">Agent Engine</a><nav class="app-nav" aria-label="Main navigation">${link("run", "/", "Run")}${link("library", "/builder", "Library")}${link("knowledge", "/knowledge", "Organizations")}</nav><nav class="app-services" aria-label="Connected services"><a href="http://localhost:8080" target="_blank" rel="noopener">Temporal UI ↗</a><a href="http://localhost:3003" target="_blank" rel="noopener">OpenHands ↗</a><a href="http://localhost:3001" target="_blank" rel="noopener">Forgejo ↗</a></nav></header>`;
  const style = `<style>
    .app-header {height:76px; padding:0 32px; background:#fff; border-bottom:1px solid #dce3dc; display:flex; align-items:center; justify-content:flex-start; gap:36px; font-family:Inter,ui-sans-serif,system-ui,sans-serif; font-size:14px; flex-wrap:nowrap;}
    .app-header a {text-decoration:none; color:#64766c;}
    .app-header .app-brand {font-size:22px; font-weight:750; letter-spacing:-.6px; color:#183b30; white-space:nowrap;}
    .app-header .app-nav {display:flex; align-self:stretch; align-items:stretch; gap:24px;}
    .app-nav a {display:flex; align-items:center; padding:0 6px; border-bottom:3px solid transparent; font-weight:600;}
    .app-nav a[aria-current="page"] {color:#246148; border-bottom-color:#246148;}
    .app-nav a:hover {color:#183b30; background:#f4f7f3;}
    .app-header .app-services {margin-left:auto; display:flex; gap:16px; font-size:13px; white-space:nowrap;}
    .app-header a:focus-visible {outline:2px solid #246148; outline-offset:3px;}
    @media(max-width:1000px) {.app-header {height:auto; min-height:76px; flex-wrap:wrap; gap:16px; padding-top:12px; padding-bottom:12px;} .app-header .app-services {flex-basis:100%; margin-left:0;} .app-header .app-nav {min-height:40px;}}
    @media(max-width:600px) {.app-header {padding:0 16px; gap:20px;} .app-header .app-brand {font-size:18px;}  .app-header .app-nav {gap:12px;}}
  </style>`;
  const assistant =
    active === "knowledge"
      ? ""
      : `<button id="section-assistant-toggle" type="button" aria-controls="section-assistant" aria-expanded="false">${active === "run" ? "Run" : "Library"} assistant</button><section id="section-assistant" data-scope="${active}" hidden aria-label="${active} assistant"><div class="sa-heading"><h2>${active === "run" ? "Run" : "Library"} assistant</h2><button id="sa-close" type="button" aria-label="Close assistant">×</button></div><p id="sa-purpose"></p><p id="sa-context"></p><div class="sa-controls"><label>Conversation<select id="sa-threads"></select></label><button id="sa-new" type="button">New chat</button></div><div id="sa-messages" role="log" aria-live="polite" tabindex="0"></div><div id="sa-proposals"></div><p id="sa-status" role="status"></p><button id="sa-latest" hidden type="button">New messages ↓</button><form id="sa-form"><label for="sa-input">Ask your ${active} assistant</label><textarea id="sa-input" rows="3" maxlength="12000" required></textarea><button id="sa-send" type="submit">Send</button></form></section><link rel="stylesheet" href="/section-assistant.css"><script src="/section-assistant.js" defer></script>`;
  return html
    .replace("<!-- APP_HEADER -->", header)
    .replace("</body>", `${assistant}</body>`)
    .replace("</head>", `${style}</head>`);
}
