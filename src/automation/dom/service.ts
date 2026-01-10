import { Page, ElementHandle } from "playwright";
import * as fs from 'fs';
import * as path from 'path';
import { build } from 'esbuild';
import { DOMState, DOMElementNode } from '../types/dom';

export class DomService {
    private page: Page;
    private selectorMap: Map<number, ElementHandle> = new Map();

    private static injectionScriptCache: string | null = null;

    constructor(page: Page) {
        this.page = page;
    }

    async getClickableState(highlight: boolean = true): Promise<DOMState> {
        const script = await this.getInjectionScript();

        const rawResult = await this.page.evaluate<{ tree: DOMElementNode; mapCount: number }, boolean>(
            `(function(shouldHighlight) {
               // The cached script puts 'window.buildDomTree' into the global scope
               ${script}
               return window.buildDomTree(shouldHighlight);
             })`,
            highlight
          );

        const { tree, mapCount } = rawResult;

        await this.rebuildSelectorMap();

        return {
            tree,
            elementMap: this.flattenTree(tree),
            selectorMap: this.selectorMap,
        };
    }

    private async rebuildSelectorMap() {
        this.selectorMap.clear();

        const elements = await this.page.$$('[data-blueberry-id]');

        for (const handle of elements) {
            const idStr = await handle.getAttribute('data-blueberry-id');
            if (idStr) {
                const id = parseInt(idStr, 10);
                this.selectorMap.set(id, handle);
            }
        }
    }

    private async getInjectionScript() {
        if (DomService.injectionScriptCache) {
            return DomService.injectionScriptCache;
        }

        const entryPoint = path.join(__dirname, 'injection', 'buildDomTree.ts');

        const result = await build({
            entryPoints: [entryPoint],
            bundle: true,
            write: false,
            format: 'iife', // Immediately Invoked Function Expression
            globalName: 'window.buildDomTree',
            footer: {
                js: 'window.buildDomTree = window.buildDomTree.buildDomTree;'
            }
        });

        DomService.injectionScriptCache = result.outputFiles[0].text;
        return DomService.injectionScriptCache;
    }

    private flattenTree(root: DOMElementNode): Map<number, DOMElementNode> {
        const map = new Map<number, DOMElementNode>();

        const traverse = (node: DOMElementNode) => {
            map.set(node.nodeId, node);
            if (node.children){
                node.children.forEach(traverse);
            }
        };

        if (root) traverse(root);

        return map;
    }

    async highlightClick(x: number, y: number, label: string = "Agent"){
        await this.page.evaluate(({ x, y, label }) => {

            let cursor = document.getElementById('blueberry-cursor');
            if (!cursor) {
                cursor = document.createElement('div');
                cursor.id = 'blueberry-cursor';
                cursor.style.position = 'fixed';
                cursor.style.zIndex = '2147483647';
                cursor.style.pointerEvents = 'none';
                cursor.style.transition = 'transform 0.3s ease-out, top 0.3s, left 0.3s';
                cursor.style.top = '0';
                cursor.style.left = '0';

                const arrow = document.createElement('div');
                arrow.innerHTML = `
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19841L11.7841 12.3673H5.65376Z" fill="#0EA5E9" stroke="white"/>
                  </svg>`;
                
                const tag = document.createElement('div');
                tag.innerText = label;
                Object.assign(tag.style, {
                position: 'absolute',
                top: '16px',
                left: '12px',
                backgroundColor: '#0EA5E9', // Sky blue
                color: 'white',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: 'bold',
                whiteSpace: 'nowrap',
                boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                });

                cursor.appendChild(arrow);
                cursor.appendChild(tag);
                document.body.appendChild(cursor);
            }

            cursor.style.transform = `translate(${x}px, ${y}px)`;

            const arrow = cursor.firstElementChild as HTMLElement;
            if (arrow) {
                arrow.style.transform = 'scale(0.8)';
                setTimeout(() => { arrow.style.transform = 'scale(1)'; }, 150);
            }

        }, { x, y, label });
    }

    async enableSpectatorMode(agentId: string) {
        await this.page.evaluate((id) => {
            const overlayId = 'blueberry-spectator-overlay';
            if (document.getElementById(overlayId)) return;

            const overlay = document.createElement('div');
            overlay.id = overlayId;

            Object.assign(overlay.style, {
                position: 'fixed',
                top: '0',
                left: '0',
                width: '100vw',
                height: '100vh',
                zIndex: '2147483646', // Just below the cursor/highlight layer
                backgroundColor: 'rgba(0, 0, 0, 0.05)', // Slight dim
                border: '6px solid #0EA5E9', // Sky blue border
                boxSizing: 'border-box',
                pointerEvents: 'all', // BLOCKS user clicks
                cursor: 'wait', // Shows "busy" cursor to user
                fontFamily: 'sans-serif'
            });

            const style = document.createElement('style');
            style.innerHTML = `
                @keyframes pulse-border {
                    0% { border-color: rgba(14, 165, 233, 0.5); }
                    50% { border-color: rgba(14, 165, 233, 1); }
                    100% { border-color: rgba(14, 165, 233, 0.5); }
                }
                #${overlayId} { animation: pulse-border 2s infinite; }
            `;

            document.head.appendChild(style);

            const dashboard = document.createElement('div');
            dashboard.id = 'blueberry-agent-thought';
            Object.assign(dashboard.style, {
                position: 'absolute',
                bottom: '20px',
                right: '20px',
                width: '320px',
                backgroundColor: '#1e293b', // Slate 800
                color: 'white',
                padding: '16px',
                borderRadius: '8px',
                boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
                fontSize: '14px',
                lineHeight: '1.5',
                opacity: '0.95',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px'
            });

            dashboard.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #334155; padding-bottom: 8px; margin-bottom: 4px;">
                    <div style="width: 8px; height: 8px; background-color: #22c55e; border-radius: 50%;"></div>
                    <span style="font-weight: bold; font-size: 12px; text-transform: uppercase; color: #94a3b8;">Agent ${id}</span>
                </div>
                <div id="blueberry-thought-text" style="color: #e2e8f0; font-style: italic;">Initializing...</div>
            `;

            overlay.appendChild(dashboard);
            document.body.appendChild(overlay);

        }, agentId);
    }

    async updateSpectatorThought(text: string) {
        await this.page.evaluate((thought) => {
            const el = document.getElementById('blueberry-thought-text');
            if (el) {

                el.style.opacity = '0.5';
                setTimeout(() => {
                    el.innerText = thought;
                    el.style.opacity = '1';
                }, 100);
            }   
        }, text);
    }

    async disableSpectatorMode() {
        await this.page.evaluate(() => {
            const overlay = document.getElementById('blueberry-spectator-overlay');
            if (overlay) overlay.remove();
        });
    }
}