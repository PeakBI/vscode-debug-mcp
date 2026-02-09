import * as http from 'http';

export const TEST_PORT = 14711;

export function callTool(toolName: string, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            type: 'callTool',
            tool: toolName,
            arguments: args,
        });

        const req = http.request({
            hostname: 'localhost',
            port: TEST_PORT,
            path: '/tcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
        }, (res) => {
            let body = '';
            res.on('data', (chunk: string) => body += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(body);
                    if (response.success) {
                        resolve(response.data);
                    } else {
                        reject(new Error(response.error || 'Unknown error'));
                    }
                } catch (err) {
                    reject(new Error(`Failed to parse response: ${body}`));
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}
