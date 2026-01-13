import { Sandbox } from "@e2b/code-interpreter";

export interface ExecutionResult {
    logs: any;
    stdout: string;
    stderr: string;
    results: any[];
    error?: string;
    artifacts?: { name: string; data: string }[];
}

let sharedInstance: E2BService | null = null;

export class E2BService {
    private sandbox: Sandbox | null = null;
    private warmingUp: Promise<Sandbox> | null = null;

    static getInstance(): E2BService {
        if (!sharedInstance) {
            sharedInstance = new E2BService();
        }
        return sharedInstance;
    }

    async warmUp(): Promise<void> {
        if (this.sandbox || this.warmingUp) return;
        console.log("[E2B] Pre-warming sandbox...");
        this.warmingUp = Sandbox.create();
        this.sandbox = await this.warmingUp;
        this.warmingUp = null;
        console.log("[E2B] Sandbox ready!");
    }

    async getSandbox(): Promise<Sandbox> {
        if (this.warmingUp) {
            return this.warmingUp;
        }
        if (!this.sandbox) {
            console.log("Creating new E2B sandbox...");
            this.sandbox = await Sandbox.create();
        }
        return this.sandbox;
    }

    async close() {
        if (this.sandbox) {
            console.log("Closing E2B sandbox...");
            await this.sandbox.kill();
            this.sandbox = null;
        }
    }

    async executeCode(code: string, files: { name: string, content: string | ArrayBuffer }[] = []): Promise<ExecutionResult> {
        console.log("Starting E2B sandbox execution");
        const sandbox = await this.getSandbox();

        try {
            // Upload files
            for (const file of files) {
                console.log(`Uploading ${file.name} ...`);
                await sandbox.files.write(file.name, file.content);
            }

            console.log('Running code ...');
            const execution = await sandbox.runCode(code, { timeoutMs: 600000 });

            if (execution.error) {

                return {
                    logs: execution.logs,
                    stdout: execution.logs.stdout.join('\n'),
                    stderr: execution.logs.stderr.join('\n'),
                    results: execution.results,
                    error: execution.error.value
                };
            }

            const sandboxFiles = await sandbox.files.list('.');
            const artifacts: { name: string; data: string }[] = [];
            const inputFilenames = new Set(files.map(f => f.name));

            for (const file of sandboxFiles) {

                if (file.type === 'dir' || file.name.startsWith('.') || inputFilenames.has(file.name)) continue;

                console.log(`Downloading generated artifact: ${file.name}`);

                const b64Result = await sandbox.runCode(`
import base64
try:
    with open('${file.name}', 'rb') as f:
        print(base64.b64encode(f.read()).decode('utf-8'))
except Exception as e:
    print(f"ERROR: {e}")
`);
                const base64Data = b64Result.logs.stdout.join('').trim();

                if (base64Data && !base64Data.startsWith('ERROR:')) {
                    artifacts.push({
                        name: file.name,
                        data: base64Data
                    });
                } else {
                    console.error(`Failed to download artifact ${file.name}: ${base64Data}`);
                }
            }

            return {
                logs: execution.logs,
                results: execution.results,
                stdout: execution.logs.stdout.join('\n'),
                stderr: execution.logs.stderr.join('\n'),
                artifacts: artifacts
            };

        } finally {
            // We do NOT kill the sandbox to allow persistence
        }
    }

    async processFileWithCode(fileBuffer: ArrayBuffer, fileName: string, code: string) {
        return this.executeCode(code, [{ name: fileName, content: fileBuffer }]);
    }
}
