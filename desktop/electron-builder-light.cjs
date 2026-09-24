const full = require('./electron-builder.cjs');
module.exports = { ...full, appId: 'cn.my12306.light', productName: 'my12306-light',
  directories: { ...full.directories, app: 'light-app', output: 'light-release' },
  files: ['main/**', 'package.json'], extraResources: [], asarUnpack: [],
  artifactName: 'my12306-light-${version}-${os}-${arch}.' + '${ext}',
};
