import { Sandbox } from "@e2b/code-interpreter";

export interface ExecutionResult {
    logs: any;
    stdout: string;
    stderr: string;
    results: any[];
    error?: string;
    artifacts?: { name: string; data: string }[];
}

export class E2BService {

    async executeCode(code: string, files: { name: string, content: string | ArrayBuffer }[] = []): Promise<ExecutionResult> {
        console.log("Starting E2B sandbox execution");
        const sandbox = await Sandbox.create();

        try {
            // Upload files
            for (const file of files) {
                console.log(`Uploading ${file.name} ...`);
                await sandbox.files.write(file.name, file.content);
            }

            console.log('Running code ...');
            const execution = await sandbox.runCode(code);

            if (execution.error) {
                // We don't throw immediately, we return the error so the agent can see it in 'output'
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
                // Skip directories, hidden files, and input files
                if (file.type === 'dir' || file.name.startsWith('.') || inputFilenames.has(file.name)) continue;

                console.log(`Downloading generated artifact: ${file.name}`);
                const fileContent = await sandbox.files.read(file.name);
                artifacts.push({
                    name: file.name,
                    data: Buffer.from(fileContent).toString('base64')
                });
            }

            return {
                logs: execution.logs,
                results: execution.results,
                stdout: execution.logs.stdout.join('\n'),
                stderr: execution.logs.stderr.join('\n'),
                artifacts: artifacts
            };

        } finally {
            await sandbox.kill();
        }
    }

    async processFileWithCode(fileBuffer: ArrayBuffer, fileName: string, code: string) {
        return this.executeCode(code, [{ name: fileName, content: fileBuffer }]);
    }
}
