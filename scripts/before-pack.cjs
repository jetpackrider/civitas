const path = require('node:path');
const { check } = require('./data-integrity.cjs');
module.exports = async context => {
  const root = context.packager.info.appDir;
  await check(path.join(root, 'web/data/block-v1'), root);
};
