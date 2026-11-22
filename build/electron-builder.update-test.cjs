// A separate bundle identity keeps its ShipIt state apart from installed SlideWell.
const { build } = require('../package.json')

module.exports = {
  ...build,
  appId: 'net.dominiklukes.slidewell.updatetest',
  productName: 'SlideWell Update Test',
  publish: null,
  files: [{ from: 'out-update-test', to: 'out' }, 'package.json'],
  mac: { ...build.mac, target: ['dir'], identity: null, notarize: false, hardenedRuntime: false }
}
