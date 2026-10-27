// Where the booking pages find the Cloud Trails booking API (the Cloudflare Worker).
// When the site is served by the Worker itself, the API is on the same address and this stays empty.
// When the site is served by GitHub Pages (cloudtrails.in), put the Worker's address here, e.g.
//   'https://cloudtrails.your-account.workers.dev'
window.CT_WORKER_URL = '';

window.CT_API = (function () {
  var h = location.hostname;
  var sameOrigin = /\.workers\.dev$/.test(h) || h === 'localhost' || h === '127.0.0.1';
  return sameOrigin ? '' : String(window.CT_WORKER_URL || '').replace(/\/+$/, '');
})();
