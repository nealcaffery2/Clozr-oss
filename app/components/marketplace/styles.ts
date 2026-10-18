// The marketplace's own sheet. Type, radius and shadows follow DESIGN.md:
// sentence case, tabular figures, radius by role, one orange primary per view.
export const MARKET_CSS = `
.hp{--ink:#18181b;--ink2:#3f3f46;--muted:#71717a;--line:#e4e4e7;--hair:#f0f0f1;--navy:#0B1F3B;--navy-2:#13294b;--brand:#c2410c;--good:#0A8560;
  --ring:0 0 0 1px rgba(0,0,0,.08),0 1px 2px -1px rgba(0,0,0,.08),0 2px 4px 0 rgba(0,0,0,.04);
  --md:0 0 0 1px rgba(0,0,0,.06),0 1px 1px -.5px rgba(0,0,0,.06),0 3px 3px -1.5px rgba(0,0,0,.06),0 6px 6px -3px rgba(0,0,0,.06),0 12px 12px -6px rgba(0,0,0,.06);
  --lg:0 2.8px 2.2px rgba(0,0,0,.034),0 6.7px 5.3px rgba(0,0,0,.048),0 12.5px 10px rgba(0,0,0,.06),0 22.3px 17.9px rgba(0,0,0,.072),0 41.8px 33.4px rgba(0,0,0,.086),0 100px 80px rgba(0,0,0,.12);
  --ease:cubic-bezier(.23,1,.32,1);
  position:fixed;inset:0;display:flex;flex-direction:column;background:#fafafa;color:var(--ink);
  font:500 13px/1.45 var(--font-inter),'Inter',-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
:where(.hp) a{color:inherit}
:where(.hp) :where(button,input,select,textarea){font:inherit;color:inherit}
.hp :focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.hp svg{flex:none}

.mk-bar{display:flex;align-items:center;gap:12px;height:60px;padding:0 16px;background:var(--navy);color:#fff;flex:none}
.mk-logo{display:flex;align-items:center;flex:none}
.mk-logo img{height:36px;width:auto;display:block}
.mk-search{position:relative;flex:1;min-width:0;max-width:420px;margin-left:8px}
.mk-search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted)}
.mk-search input{height:36px;width:100%;padding:0 12px 0 34px;border:0;border-radius:8px;background:#fff;color:var(--ink);font-size:13px}
.mk-search input::placeholder{color:var(--muted)}
.mk-bar-end{display:flex;align-items:center;gap:8px;margin-left:auto}
.mk-hello{font-size:13px;color:rgba(255,255,255,.8);white-space:nowrap}
.mk-dark-btn{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 12px;border:1px solid rgba(255,255,255,.22);border-radius:8px;background:transparent;color:#fff !important;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;transition:transform 140ms var(--ease)}
.mk-dark-btn.is-on{background:#fff;color:var(--navy) !important;border-color:#fff}
.mk-dark-btn:active{transform:scale(.97)}
.mk-icon-only{width:36px;padding:0;justify-content:center}
.mk-count{min-width:18px;height:18px;padding:0 5px;border-radius:6px;background:var(--brand);color:#fff;font-size:11px;font-weight:600;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}

.mk-banner{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px 16px;background:#fff7ed;border-bottom:1px solid #fed7aa;color:#7c2d12;font-size:12.5px;flex:none}
.mk-banner .mk-link{color:var(--brand)}

.mk-primary,.mk-ghost{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border:0;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;cursor:pointer;transition:transform 140ms var(--ease),filter 140ms ease}
.mk-primary{background:var(--brand);color:#fff !important}
.mk-ghost{background:#fff;color:var(--ink) !important;box-shadow:var(--ring)}
.mk-ghost-sm{height:28px;padding:0 10px;font-size:12px}
.mk-primary:active:not(:disabled),.mk-ghost:active{transform:scale(.97)}
.mk-primary:disabled{opacity:.5;cursor:default}
.mk-wide{width:100%;height:40px}
.mk-link{border:0;background:none;padding:0;color:var(--brand);font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.mk-link:disabled{opacity:.5}
.mk-text-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--ink2);font-size:12.5px;font-weight:600;cursor:pointer}
.mk-text-btn[aria-pressed=true]{color:var(--brand)}
.mk-icon-btn{display:inline-grid;place-items:center;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--ink2);cursor:pointer}

.mk-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 620px}
.mk-map{position:relative;min-height:0}
.mk-map-canvas{position:absolute;inset:0;background:#eef0f2}
.mk-layers{position:absolute;top:12px;left:12px;z-index:500;display:flex;gap:2px;padding:3px;background:#fff;border-radius:10px;box-shadow:var(--md)}
.mk-layers button{height:28px;padding:0 11px;border:0;border-radius:7px;background:transparent;font-size:12.5px;font-weight:600;color:var(--ink2);cursor:pointer}
.mk-layers button.is-on{background:var(--ink);color:#fff}

.mk-rail{background:#fff;border-left:1px solid var(--line);min-height:0;display:flex;flex-direction:column}
.mk-rail-head{padding:16px 16px 10px;border-bottom:1px solid var(--hair)}
.mk-rail-head h1{margin:0 0 12px;font-size:17px;font-weight:700;letter-spacing:-.015em}
.mk-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.mk-select{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:0;border-radius:8px;background:#fff;box-shadow:var(--ring);font-size:12.5px;font-weight:500;color:var(--ink);cursor:pointer;max-width:200px}
.mk-select.is-on{background:var(--ink);color:#fff;box-shadow:none}
.mk-filter-hint{display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:12px;margin-left:2px}
.mk-rail-sub{display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums}
.mk-sort{display:inline-flex;align-items:center;gap:6px}
.mk-sort select{border:0;background:transparent;color:var(--brand);font-weight:600;cursor:pointer;padding:2px 0}
.mk-drop{position:relative}
.mk-drop-back{position:fixed;inset:0;z-index:40;border:0;background:transparent;cursor:default}
.mk-drop-panel{position:absolute;top:38px;left:0;z-index:41;min-width:240px;padding:12px;background:#fff;border-radius:10px;box-shadow:var(--md);display:grid;gap:8px;animation:hpPop 160ms var(--ease);transform-origin:top left}
.mk-drop-panel label{display:grid;gap:4px;font-size:12px;color:var(--ink2)}
.mk-drop-panel input[inputmode]{height:34px;padding:0 10px;border:0;border-radius:8px;box-shadow:var(--ring);font-size:13px}
.mk-check-row{display:flex !important;grid-template-columns:none !important;align-items:center;gap:8px;font-size:13px !important;color:var(--ink) !important;cursor:pointer}
.mk-check-row input{width:16px;height:16px;accent-color:var(--brand)}

.mk-scroll{flex:1;min-height:0;overflow:auto;padding:14px 16px 32px}
.mk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.mk-card{position:relative;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;transition:box-shadow 140ms ease}
.mk-card.is-skeleton{height:268px;background:linear-gradient(#f4f4f5,#f4f4f5) 0 0/100% 150px no-repeat,#fff}
.mk-card-hit{position:absolute;inset:0;z-index:1;border:0;background:transparent;cursor:pointer;border-radius:12px}
.mk-photo{position:relative;height:160px;background:#f4f4f5}
.mk-nophoto{display:grid;place-items:center;align-content:center;gap:6px;width:100%;height:100%;color:var(--muted);font-size:12px;background:#f4f4f5}
.mk-flag{position:absolute;top:10px;left:10px;height:22px;padding:0 8px;border-radius:6px;background:var(--navy);color:#fff;font-size:11px;font-weight:600;line-height:22px}
.mk-flag.is-pending{background:#fff;color:var(--ink);box-shadow:var(--ring)}
.mk-new{position:absolute;bottom:10px;right:10px;height:22px;padding:0 8px;border-radius:6px;background:rgba(9,9,11,.72);color:#fff;font-size:11px;font-weight:600;line-height:22px}
.mk-heart{position:absolute;top:8px;right:8px;z-index:2;display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:8px;background:rgba(255,255,255,.94);color:var(--ink2);box-shadow:var(--ring);cursor:pointer;transition:transform 140ms var(--ease)}
.mk-heart[aria-pressed=true]{color:#dc2626}
.mk-heart:active{transform:scale(.92)}
.mk-card-copy{padding:12px 14px 14px}
.mk-price-line{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.mk-price{font-size:18px;font-weight:700;letter-spacing:-.015em;font-variant-numeric:tabular-nums}
.mk-arv{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.mk-where{margin-top:3px;font-size:12.5px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mk-icons{display:flex;gap:14px;margin-top:10px;color:var(--ink2);font-size:12.5px;font-variant-numeric:tabular-nums}
.mk-icons span{display:inline-flex;align-items:center;gap:5px}
.mk-icons svg{color:var(--muted)}
.mk-empty{display:grid;justify-items:center;gap:10px;padding:48px 16px;color:var(--muted);text-align:center}
.mk-empty p{margin:0}

.mk-page{flex:1;min-height:0;overflow:auto;background:#fafafa}
.mk-page-inner{max-width:1180px;margin:0 auto;padding:12px 20px 64px}
.mk-back{display:inline-flex;align-items:center;gap:4px;height:32px;padding:0 8px 0 4px;margin-left:-4px;border:0;border-radius:8px;background:transparent;color:var(--ink2);font-size:13px;font-weight:600;cursor:pointer}
.mk-gallery{display:grid;grid-template-columns:2fr 1fr 1fr;grid-template-rows:200px 200px;gap:6px;margin-top:8px;border-radius:14px;overflow:hidden}
.mk-gallery.is-single{grid-template-columns:3fr 2fr;grid-template-rows:380px}
.mk-gallery.is-single .mk-gallery-main{grid-row:auto}
.mk-gallery-aerial{position:relative;background:#e4e4e7}
.mk-aerial-tag{position:absolute;left:10px;bottom:10px;z-index:500;height:22px;padding:0 8px;border-radius:6px;background:rgba(9,9,11,.72);color:#fff;font-size:11px;font-weight:600;line-height:22px}
.mk-gallery>button{position:relative;display:block;padding:0;border:0;background:#e4e4e7;cursor:pointer;overflow:hidden;color:inherit}
.mk-gallery-main{grid-row:1/3}
.mk-gallery-main .mk-flag{top:14px;left:14px}
.mk-blur{position:absolute;inset:-16px;background-size:cover;background-position:center;filter:blur(14px) brightness(.55)}
.mk-tile-empty{display:grid;place-items:center;width:100%;height:100%;color:#a1a1aa;background:#f4f4f5}
.mk-tile-lock{position:absolute;top:10px;left:10px;display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:rgba(255,255,255,.9);color:var(--ink)}
.mk-gallery-tile.is-locked:not(:has(.mk-blur)){background:#27272a}
.mk-tile-cta{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:10px;padding:12px;color:#fff;text-align:center;background:rgba(9,9,11,.35)}
.mk-tile-cta strong{font-size:13px;font-weight:600}

.mk-where-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px;margin:18px 0 16px}
.mk-where-title{display:flex;align-items:center;gap:8px;margin:0;font-size:18px;font-weight:700;letter-spacing:-.015em}
.mk-where-title svg{color:var(--brand)}
.mk-where-meta{display:flex;gap:14px;margin-left:auto;color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums}
.mk-where-meta span{display:inline-flex;align-items:center;gap:5px}

.mk-layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
.mk-main{display:grid;gap:12px;min-width:0}
.mk-side{position:sticky;top:12px;display:grid;gap:12px}
.mk-box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.mk-box h2{margin:0 0 10px;font-size:15px;font-weight:700;letter-spacing:-.01em}
.mk-muted{margin:-4px 0 12px;color:var(--muted);font-size:12.5px}
.mk-specs{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;padding:14px 18px}
.mk-spec{display:flex;align-items:center;gap:10px;min-width:0}
.mk-spec-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:#f4f4f5;color:var(--ink2);flex:none}
.mk-spec-k{display:block;font-size:11.5px;color:var(--muted)}
.mk-spec strong{display:block;font-size:14px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mk-desc{margin:0;color:var(--ink2);font-size:13.5px;line-height:1.6;white-space:pre-line;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.mk-desc.is-open{display:block}
.mk-box .mk-link{margin-top:8px;font-size:12.5px}
.mk-grid-dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:0}
.mk-grid-dl dt{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted)}
.mk-grid-dl dd{margin:3px 0 0 22px;font-size:13.5px;font-weight:600}
.mk-docs{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
.mk-doc{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--line);border-radius:10px;background:#fff;text-align:left;text-decoration:none;cursor:pointer;color:var(--ink)}
.mk-doc.is-off{cursor:default;opacity:.6}
.mk-doc-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:#fff7ed;color:var(--brand);flex:none}
.mk-doc-copy{display:grid;flex:1;min-width:0}
.mk-doc-copy strong{font-size:13px;font-weight:650}
.mk-doc-copy span{font-size:12px;color:var(--muted)}
.mk-doc>svg{color:var(--muted)}
.mk-mini-map{position:relative;height:260px;border-radius:10px;overflow:hidden}
.mk-accordion details{border-top:1px solid var(--hair)}
.mk-accordion details:first-child{border-top:0}
.mk-accordion summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;font-size:13px;font-weight:600;cursor:pointer;list-style:none}
.mk-accordion summary::-webkit-details-marker{display:none}
.mk-accordion summary svg{color:var(--muted);transition:transform 160ms var(--ease)}
.mk-accordion details[open] summary svg{transform:rotate(180deg)}
.mk-accordion p{margin:0 0 12px;color:var(--ink2);font-size:12.5px;line-height:1.6}

.mk-price-box{display:grid;gap:10px}
.mk-price-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-variant-numeric:tabular-nums}
.mk-price-row span{color:var(--muted);font-size:12.5px}
.mk-price-row strong{font-size:15px;font-weight:650}
.mk-price-row:first-child strong{font-size:24px;font-weight:700;letter-spacing:-.02em}
.mk-price-row.is-sub{padding-top:8px;border-top:1px solid var(--hair)}
.mk-price-row.is-sub strong{color:var(--good)}
.mk-side-row{display:flex;justify-content:center;gap:12px}
.mk-agent{display:grid;grid-template-columns:52px 1fr;gap:10px 12px;align-items:center}
.mk-agent img{width:52px;height:52px;border-radius:12px;object-fit:cover}
.mk-agent strong{display:block;font-size:13.5px}
.mk-agent span{display:block;font-size:12px;color:var(--muted)}
.mk-agent .mk-wide{grid-column:1/-1}

.mk-toggle{display:none}
.mk-modal{position:fixed;inset:0;z-index:800;display:grid;place-items:center;padding:16px;animation:hpFade 200ms var(--ease)}
.mk-modal-back{position:absolute;inset:0;border:0;background:rgba(9,9,11,.45);cursor:pointer}
.mk-gate{position:relative;width:min(460px,100%);max-height:calc(100dvh - 32px);overflow:auto;background:#fff;border-radius:16px;box-shadow:var(--lg);animation:hpPop 200ms var(--ease)}
.mk-gate-head{display:flex;align-items:center;gap:10px;padding:10px 10px 10px 18px;border-bottom:1px solid var(--hair)}
.mk-gate-head .mk-icon-btn:first-child{margin-left:-8px}
.mk-gate-lock{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#fff7ed;color:var(--brand)}
.mk-gate-kicker{flex:1;font-size:12.5px;font-weight:600;color:var(--ink2)}
.mk-gate-body{padding:18px 20px 20px}
.mk-gate-body h2{margin:0;font-size:20px;font-weight:700;letter-spacing:-.02em}
.mk-gate-sub{margin:6px 0 14px;color:var(--muted);font-size:13px;line-height:1.5}
.mk-perks{list-style:none;margin:0 0 16px;padding:12px 14px;display:grid;gap:6px;background:#f8fafc;border-radius:10px;font-size:12.5px;color:var(--ink2)}
.mk-perks li{display:flex;align-items:center;gap:8px}
.mk-perks svg{color:var(--good)}
.mk-form{display:grid;gap:12px}
.mk-form label{display:grid;gap:5px;font-size:12.5px;font-weight:500;color:var(--ink2)}
.mk-form input:not([type=checkbox]),.mk-form select,.mk-form textarea,.mk-form fieldset>input{height:38px;width:100%;padding:0 11px;border:0;border-radius:8px;background:#fff;box-shadow:var(--ring);font-size:13.5px;color:var(--ink)}
.mk-form textarea{height:auto;padding:10px 11px;resize:vertical;line-height:1.5}
.mk-form fieldset{margin:0;padding:0;border:0;display:grid;gap:8px}
.mk-form legend{padding:0;margin-bottom:8px;font-size:12.5px;font-weight:600;color:var(--ink)}
.mk-opt{color:var(--muted);font-weight:400}
.mk-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.mk-three{display:grid;grid-template-columns:1fr 1fr .8fr;gap:10px}
.mk-check{display:grid !important;grid-template-columns:18px 1fr;align-items:start;gap:10px !important;font-size:12px !important;line-height:1.5;color:var(--muted) !important}
.mk-check input{width:16px;height:16px;margin:1px 0 0;accent-color:var(--brand)}
.mk-check a{color:var(--brand)}
.mk-chips{display:flex;flex-wrap:wrap;gap:6px}
.mk-chip{height:30px;padding:0 11px;border:0;border-radius:8px;background:#fff;box-shadow:var(--ring);font-size:12.5px;font-weight:500;color:var(--ink2);cursor:pointer}
.mk-chip[aria-pressed=true]{background:var(--ink);color:#fff;box-shadow:none}
.mk-err{margin:0;color:#b91c1c;font-size:12.5px}
.mk-gate-switch{margin:0;text-align:center;color:var(--muted);font-size:12.5px}
.mk-gate-switch button{border:0;background:none;padding:0;color:var(--brand);font-weight:600;cursor:pointer}
.mk-trap{position:absolute;left:-9999px;width:1px;height:1px}

.mk-viewer{position:fixed;inset:0;z-index:900;display:grid;place-items:center;background:rgba(9,9,11,.92);animation:hpFade 200ms var(--ease)}
.mk-viewer-img{width:min(1100px,92vw);height:min(760px,82vh)}
.mk-viewer-img span{background:transparent !important}
.mk-viewer-close{position:absolute;top:14px;right:14px;color:#fff;background:rgba(255,255,255,.12)}
.mk-viewer-nav{position:absolute;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:10px;background:rgba(255,255,255,.12);color:#fff;cursor:pointer}
.mk-viewer-nav.is-prev{left:16px}
.mk-viewer-nav.is-next{right:16px}
.mk-viewer-count{position:absolute;bottom:18px;color:#fff;font-size:12.5px;font-variant-numeric:tabular-nums}

.mk-toast{position:fixed;left:50%;bottom:24px;z-index:950;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:10px 14px;border-radius:10px;background:var(--ink);color:#fff;font-size:13px;font-weight:500;box-shadow:var(--md);animation:hpToast 200ms var(--ease)}

@keyframes hpFade{from{opacity:0}}
@keyframes hpPop{from{opacity:0;transform:scale(.96)}}
@keyframes hpToast{from{opacity:0;transform:translate(-50%,6px)}}

.leaflet-container{font-family:inherit;background:#eef0f2}
.leaflet-top.leaflet-right{margin:4px 4px 0 0}
.hp .leaflet-bar{border:0;border-radius:10px;overflow:hidden;box-shadow:var(--md)}
.hp .leaflet-bar a{width:32px;height:32px;line-height:30px;color:var(--ink);border-bottom:1px solid var(--hair)}
.hp .leaflet-bar a:last-child{border-bottom:0}
.hp .leaflet-control-attribution{font-size:10.5px}
.mk-pin-wrap{background:transparent !important;border:0 !important}
.mk-pin{position:absolute;left:0;top:0;transform:translate(-50%,calc(-100% - 7px));white-space:nowrap}
.mk-pin>span{position:relative;display:block;height:26px;padding:0 9px;border-radius:8px;background:var(--navy);color:#fff;
  font:650 12px/26px var(--font-inter),'Inter',-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;font-variant-numeric:tabular-nums;
  box-shadow:0 0 0 1.5px #fff,0 2px 8px -1px rgba(0,0,0,.3);transform-origin:50% 100%;transition:transform 140ms var(--ease)}
.mk-pin>span::after{content:'';position:absolute;left:50%;bottom:-5px;width:9px;height:9px;margin-left:-4.5px;background:inherit;transform:rotate(45deg);border-radius:0 0 2px 0;box-shadow:1.5px 1.5px 0 0 #fff}
.mk-pin.is-pending>span{background:#52525b}
.mk-pin.is-on>span{background:var(--brand);transform:scale(1.08)}
.mk-cluster{position:absolute;left:0;top:0;transform:translate(-50%,-50%);display:grid;place-items:center;border-radius:50%;background:var(--brand);color:#fff;
  font:700 12.5px/1 var(--font-inter),'Inter',-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;font-variant-numeric:tabular-nums;
  box-shadow:0 0 0 4px rgba(194,65,12,.25),0 0 0 1.5px #fff inset,0 2px 8px rgba(0,0,0,.25);cursor:pointer;transition:transform 140ms var(--ease)}
.leaflet-marker-icon:has(.mk-pin.is-on){z-index:1000 !important}

@media (hover:hover) and (pointer:fine){
  .mk-primary:hover:not(:disabled){filter:brightness(.92)}
  .mk-ghost:hover,.mk-back:hover,.mk-text-btn:hover,.mk-icon-btn:hover{background:#f4f4f5}
  .mk-dark-btn:hover:not(.is-on){background:rgba(255,255,255,.08)}
  .mk-layers button:not(.is-on):hover,.mk-chip:not([aria-pressed=true]):hover{background:#f4f4f5}
  .mk-card:hover{box-shadow:var(--md)}
  .mk-doc:not(.is-off):hover{background:#fafafa}
  .mk-pin>span:hover,.mk-cluster:hover{transform:scale(1.08)}
}
@media (prefers-reduced-motion:reduce){
  .hp *,.hp *::after{animation:none !important;transition:none !important}
}
@media (max-width:1180px){
  .mk-body{grid-template-columns:minmax(0,1fr) 420px}
  .mk-grid{grid-template-columns:1fr}
}
@media (max-width:900px){
  .mk-layout{grid-template-columns:1fr}
  .mk-side{position:static}
  .mk-gallery:not(.is-single){grid-template-columns:1fr 1fr;grid-template-rows:240px 110px}
  .mk-gallery.is-single{grid-template-columns:1fr;grid-template-rows:260px 180px}
  .mk-gallery-main{grid-row:auto;grid-column:1/-1}
  .mk-gallery-tile:nth-of-type(n+4){display:none}
}
@media (max-width:760px){
  .mk-bar{flex-wrap:wrap;height:auto;padding:10px 12px;row-gap:10px}
  .mk-logo img{height:26px}
  .mk-search{flex:1 1 100%;max-width:none;margin:0;order:3}
  .mk-hello{display:none}
  .mk-search input,.mk-form input:not([type=checkbox]),.mk-form select,.mk-form textarea,.mk-drop-panel input[inputmode]{font-size:16px}
  .mk-body{grid-template-columns:1fr}
  .mk-map{display:none}
  .mk-map-on .mk-map{display:block}
  .mk-map-on .mk-rail{display:none}
  .mk-banner{flex-wrap:wrap;text-align:center}
  .mk-specs{grid-template-columns:repeat(2,minmax(0,1fr))}
  .mk-page-inner{padding:10px 12px 48px}
  .mk-where-meta{margin-left:0}
  .mk-three{grid-template-columns:1fr 1fr}
  .mk-toggle{display:inline-flex;align-items:center;gap:6px;height:40px;position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:600;background:var(--ink);color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:600;box-shadow:var(--md);cursor:pointer}
}
`;
