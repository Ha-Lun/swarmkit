# hard fixture

Four independent modules. Each `src/<m>.js` starts as a stub with the spec in its header comment;
`test/<m>.test.js` is the contract (plain node asserts, run with `node test/<m>.test.js`).

Reference solutions live in `../hard-reference/src/` and are never copied into worker fixtures.
To check the contract: copy `hard/` somewhere, copy the reference `src/*.js` over its stubs and run
`node test/<m>.test.js` for each module (all four pass); with the stubs every case fails.
