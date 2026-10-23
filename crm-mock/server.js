'use strict';

const { createCrm } = require('./app');

const port = Number(process.env.PORT || 4000);
const crm = createCrm();

crm.start(port).then((p) => {
  console.log(JSON.stringify({ service: 'mock-crm', msg: 'listening', port: p, leadsPage: `http://localhost:${p}/` }));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await crm.stop();
    process.exit(0);
  });
}
