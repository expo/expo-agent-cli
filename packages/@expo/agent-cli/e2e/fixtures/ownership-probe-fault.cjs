// Fault only the OS connection boundary for one fixture-owned endpoint. The real CLI
// still decides whether an ambiguous connection permits admission or record discard.
const net = require('node:net');
const connect = net.connect;
net.connect = function (address, ...args) {
  if (address !== process.env.OWNERSHIP_TEST_ENDPOINT) return connect.call(this, address, ...args);
  const socket = new net.Socket();
  if (process.env.OWNERSHIP_TEST_FAULT === 'EACCES') {
    process.nextTick(() =>
      socket.destroy(Object.assign(new Error('Permission denied'), { code: 'EACCES' }))
    );
  }
  // Otherwise leave the connection pending so the production deadline must settle it.
  return socket;
};
