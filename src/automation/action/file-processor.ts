import { E2BService, ExecutionResult } from "../sandbox/e2b-service";
import { LLMProvider } from "../core/llm";


const e2b = E2BService.getInstance();

export async function handleFileTask(
    fileBuffer: ArrayBuffer,
    fileName: string,
    userPrompt: string,
    llm: LLMProvider,
    onCodeStream?: (code: string, isComplete: boolean) => void
): Promise<ExecutionResult> {

    const systemPrompt = `
You are an expert Python Developer and Data Scientist.
The user has uploaded a file named "${fileName}".
Your task is to write a Python script to handle the user's request: "${userPrompt}".

Guidelines:
1. **Load the file**: Assume "${fileName}" is in the current working directory. Detect the format (csv, xlsx, json, etc.) automatically or based on extension.
2. **Robustness**: 
   - When reshaping data (pivot), ALWAYS use \`df.pivot_table()\` with an appropriate \`aggfunc\` (e.g., 'sum', 'mean') instead of \`df.pivot()\` to avoid "cannot assemble with duplicate keys" errors.
   - Handle missing values gracefully.
3. **Visualization**:
   - If the user asks for a plot/chart, use \`matplotlib\` or \`seaborn\`.
   - ALWAYS save plots to a file (e.g., \`plt.savefig('plot.png')\`). Do NOT use \`plt.show()\`.
4. **Output**: 
   - Print insights and text results to stdout.
   - If generating new files (plots, transformed data), save them to the current directory '.'.
5. **Format**: Return ONLY valid Python code. No markdown blocks. No explanations.
    `;

    console.log("[FileTask] Streaming Python code generation...");

    let code = '';
    const stream = llm.stream([{
        role: 'system',
        content: systemPrompt
    }, {
        role: 'user',
        content: `File: ${fileName}\nRequest: ${userPrompt}`
    }]);

    for await (const chunk of stream) {
        code += chunk;
        if (onCodeStream) {
            onCodeStream(code, false);
        }
    }

    // Clean up markdown code blocks
    if (code.startsWith('\`\`\`')) {
        code = code.replace(/^\`\`\`python\n?/, '').replace(/\`\`\`$/, '');
    }
    code = code.trim();

    // Final update with cleaned code
    if (onCodeStream) {
        onCodeStream(code, true);
    }

    console.log("[FileTask] Executing generated code...");
    const result = await e2b.processFileWithCode(fileBuffer, fileName, code);

    return result;
}