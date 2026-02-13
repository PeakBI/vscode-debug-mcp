function setup() {
    const value = 42;
    return value;
}

function main() {
    const x = setup();
    throw new Error('Intentional test exception: ' + x);
}

main();
