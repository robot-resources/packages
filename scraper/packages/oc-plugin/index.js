/**
 * Robot Resources scraper OC plugin — shim entry point.
 *
 * Static import of plugin-core.js so register() runs sync. OC 2026.4.24
 * enforces synchronous register() and rolls back any plugin whose register
 * returns a Promise (verified during PR 2/2.5 hook trajectory analysis on
 * the router plugin). Same constraint applies here.
 */

import core from './lib/plugin-core.js';

const shim = {
  id: 'robot-resources-scraper-oc-plugin',
  name: 'Robot Resources Scraper Hook',
  description: 'Redirects web_fetch tool calls to scraper_compress_url',
  register(api) {
    return core.register(api);
  },
};

export default shim;
