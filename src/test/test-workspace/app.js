function helper(a, b) {
    const sum = a + b;
    return sum;
}

function main() {
    const x = 10;
    const y = 20;
    const result = helper(x, y);
    const doubled = result * 2;
    console.log(doubled);
}

main();
