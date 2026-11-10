// HTML for the opening title card and the closing card. Rendered by Playwright, so no font
// or drawtext setup is needed in ffmpeg.

export const LIVE_URL = "https://invoicepilot-kysh.onrender.com";
export const REPO_URL = "https://github.com/Mugilan718/invoicepilot";

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1920px; height: 1080px; }
  body {
    font-family: "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif;
    color: #f4f4f5;
    background: radial-gradient(1200px 700px at 30% 20%, #312e81 0%, #18181b 55%, #09090b 100%);
    display: flex; align-items: center; justify-content: center;
  }
  .logo { width: 120px; height: 120px; border-radius: 28px; background: #4f46e5; display: flex;
    align-items: center; justify-content: center; box-shadow: 0 20px 60px rgba(79,70,229,.45); }
  .logo svg { width: 64px; height: 64px; }
`;

const LOGO = `<div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg></div>`;

export const titleCardHtml = () => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  .wrap { display: flex; flex-direction: column; align-items: center; gap: 44px; text-align: center; }
  h1 { font-size: 132px; font-weight: 700; letter-spacing: -3px; }
  p { font-size: 46px; color: #c7d2fe; font-weight: 400; }
</style></head><body><div class="wrap">${LOGO}<h1>InvoicePilot</h1>
<p>AI agent for freelancer invoicing with PayPal</p></div></body></html>`;

export const closingCardHtml = () => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  .wrap { display: flex; flex-direction: column; align-items: center; gap: 36px; text-align: center; }
  .in { opacity: 0; transform: translateY(18px); animation: rise .9s ease-out forwards; }
  @keyframes rise { to { opacity: 1; transform: none; } }
  h1 { font-size: 112px; font-weight: 700; letter-spacing: -3px; }
  .tag { font-size: 40px; color: #c7d2fe; }
  .chips { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; max-width: 1500px; margin-top: 12px; }
  .chip { font-size: 28px; padding: 12px 24px; border-radius: 999px; background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.16); color: #e4e4e7; }
  .links { margin-top: 28px; display: grid; grid-template-columns: auto auto; gap: 14px 28px; text-align: left; font-size: 36px; }
  .links .k { color: #a1a1aa; }
  .links .v { color: #fff; font-weight: 600; }
</style></head><body><div class="wrap">
  <div class="in" style="animation-delay:.1s">${LOGO}</div>
  <h1 class="in" style="animation-delay:.3s">InvoicePilot</h1>
  <p class="tag in" style="animation-delay:.5s">Gets freelancers paid faster, with a human in the loop.</p>
  <div class="chips">
    ${["Next.js on Render", "Gemini function calling", "Server-side validation", "Model fallback", "PayPal Invoicing API", "AG Grid"]
      .map((c, i) => `<span class="chip in" style="animation-delay:${2 + i * 1.6}s">${c}</span>`)
      .join("")}
  </div>
  <div class="links in" style="animation-delay:12s">
    <span class="k">Live demo</span><span class="v">${LIVE_URL.replace("https://", "")}</span>
    <span class="k">Source</span><span class="v">${REPO_URL.replace("https://", "")}</span>
  </div>
</div></body></html>`;
