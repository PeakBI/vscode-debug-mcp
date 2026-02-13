const { processData } = require('./utils');

function main() {
    const input = 42;
    const output = processData(input);
    const final = output + 1;
    console.log(final);
}

main();
