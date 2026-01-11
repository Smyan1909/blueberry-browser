import { Page, ElementHandle } from "playwright";
import * as path from 'path';
import { build } from 'esbuild';
// Note: Sharp removed - using Canvas API in browser for GPU-accelerated box drawing
import { DOMState, DOMElementNode } from '../types/dom';

interface ElementBox {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export class DomService {
    private page: Page;
    private selectorMap: Map<number, ElementHandle> = new Map();
    private spectatorModeEnabled: boolean = false;
    private currentAgentId: string = '';

    private static injectionScriptCache: string | null = null;

    constructor(page: Page) {
        this.page = page;
        this.setupNavigationListeners();
    }

    private setupNavigationListeners() {
        // Re-inject spectator mode overlay and cursor after navigation
        this.page.on('domcontentloaded', async () => {
            if (this.spectatorModeEnabled) {
                console.log('[DomService] Page navigated, re-injecting spectator overlay and cursor');
                await this.injectSpectatorOverlay(this.currentAgentId);
                // Re-show cursor after navigation
                await this.showCursor(50, 50, this.currentAgentId);
            }
        });
    }

    async getClickableState(highlight: boolean = true): Promise<DOMState> {
        const script = await this.getInjectionScript();

        try {
            const rawResult = await this.page.evaluate(({ script, highlight }) => {

                if (typeof (window as any).buildDomTreeTemp === 'undefined') {
                    eval(script);
                }

                const library = (window as any).buildDomTreeTemp;

                if (!library) {
                    if ((window as any).buildDomTree) {
                        return (window as any).buildDomTree(highlight);
                    }
                    throw new Error(`Injected script loaded, but 'buildDomTree' was not found on window.`);
                }

                const buildDomTreeFn = library.buildDomTree || library.default || library;

                if (typeof buildDomTreeFn !== 'function') {
                    throw new Error(`Found library, but 'buildDomTree' is not a function in the library.`);
                }

                const result = buildDomTreeFn(document.body, highlight);

                if (!result) {
                    throw new Error('buildDomTree returned null/undefined');
                }

                return result
            }, { script, highlight });

            if (!rawResult) {
                throw new Error("Page analysis returned empty result.");
            }

            const { tree, mapCount } = rawResult;

            await this.rebuildSelectorMap();

            return {
                tree,
                elementMap: this.flattenTree(tree),
                selectorMap: this.selectorMap,
            };

        } catch (error: any) {
            console.error('[DomService] Error getting clickable state:', error);
            // Helpful debug log if it fails again
            console.log("[DomService] Debug Tip: Open Electron DevTools and type 'window.buildDomTreeTemp' to check if script injected.");
            throw error;
        }
    }

    private async rebuildSelectorMap() {
        this.selectorMap.clear();

        // Get element handles
        const elements = await this.page.$$('[data-blueberry-id]');

        // Get ALL IDs in a single page.evaluate (one round-trip instead of N)
        const allIds: (string | null)[] = await this.page.evaluate(() => {
            return Array.from(document.querySelectorAll('[data-blueberry-id]'))
                .map(el => el.getAttribute('data-blueberry-id'));
        });

        // Build map locally (no more awaits in loop)
        for (let i = 0; i < elements.length && i < allIds.length; i++) {
            const idStr = allIds[i];
            if (idStr) {
                this.selectorMap.set(parseInt(idStr, 10), elements[i]);
            }
        }
    }

    private async getInjectionScript() {
        if (DomService.injectionScriptCache) {
            return DomService.injectionScriptCache;
        }

        const entryPoint = path.join(process.cwd(), 'src/automation/dom/injection/buildDomTree.ts');
        try {
            const result = await build({
                entryPoints: [entryPoint],
                bundle: true,
                write: false,
                format: 'iife', // Immediately Invoked Function Expression
                globalName: 'buildDomTreeTemp', // Use a temp name that won't collide
                // CHANGE: Simplified footer to just ensure the var is returned if needed, 
                // but our new evaluate strategy relies mostly on 'buildDomTreeTemp' existing.
                footer: {
                    js: 'window.buildDomTree = typeof buildDomTreeTemp !== "undefined" ? (buildDomTreeTemp.buildDomTree || buildDomTreeTemp) : null;'
                }
            });

            if (!result.outputFiles || result.outputFiles.length === 0) {
                throw new Error('No output files generated');
            }

            DomService.injectionScriptCache = result.outputFiles[0].text;
            return DomService.injectionScriptCache;
        } catch (error: any) {
            console.error('[DomService] Error building injection script:', error);
            console.error('[DomService] Entry point:', entryPoint);
            throw error;
        }
    }

    private flattenTree(root: DOMElementNode): Map<number, DOMElementNode> {
        const map = new Map<number, DOMElementNode>();

        const traverse = (node: DOMElementNode) => {
            map.set(node.nodeId, node);
            if (node.children) {
                node.children.forEach(traverse);
            }
        };

        if (root) traverse(root);

        return map;
    }

    /**
     * Show or move the ghost cursor to a specific position
     * The cursor persists on screen to show the agent is active
     */
    private async showCursor(x: number, y: number, label: string) {
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
                tag.id = 'blueberry-cursor-label';
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
            } else {
                // Update the label if it exists
                const tag = document.getElementById('blueberry-cursor-label');
                if (tag) {
                    tag.innerText = label;
                }
            }

            cursor.style.transform = `translate(${x}px, ${y}px)`;
        }, { x, y, label });
    }

    async highlightClick(x: number, y: number, label: string = "Agent") {
        // Move cursor to click position and animate
        await this.showCursor(x, y, label);

        // Add click animation
        await this.page.evaluate(() => {
            const cursor = document.getElementById('blueberry-cursor');
            if (cursor) {
                const arrow = cursor.firstElementChild as HTMLElement;
                if (arrow) {
                    arrow.style.transform = 'scale(0.8)';
                    setTimeout(() => { arrow.style.transform = 'scale(1)'; }, 150);
                }
            }
        });
    }

    async enableSpectatorMode(agentId: string) {
        this.spectatorModeEnabled = true;
        this.currentAgentId = agentId;
        await this.injectSpectatorOverlay(agentId);
        // Show cursor immediately so user knows agent is active
        await this.showCursor(50, 50, agentId);
    }

    private async injectSpectatorOverlay(agentId: string) {
        await this.page.evaluate((id) => {
            const overlayId = 'blueberry-spectator-overlay';

            // Remove existing overlay if present
            const existing = document.getElementById(overlayId);
            if (existing) existing.remove();

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
                pointerEvents: 'none', // Let clicks pass through to page elements
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
        // Check if overlay exists, re-inject if missing
        const overlayExists = await this.page.evaluate(() => {
            return !!document.getElementById('blueberry-thought-text');
        });

        if (!overlayExists && this.spectatorModeEnabled) {
            console.log('[DomService] Overlay missing, re-injecting...');
            await this.injectSpectatorOverlay(this.currentAgentId);
        }

        // Update thought directly (removed opacity animation delay for speed)
        await this.page.evaluate((thought) => {
            const el = document.getElementById('blueberry-thought-text');
            if (el) {
                el.innerText = thought;
            }
        }, text);
    }

    async disableSpectatorMode() {
        this.spectatorModeEnabled = false;
        await this.page.evaluate(() => {
            const overlay = document.getElementById('blueberry-spectator-overlay');
            if (overlay) overlay.remove();

            const cursor = document.getElementById('blueberry-cursor');
            if (cursor) cursor.remove();
        });
    }


    /**
     * Capture the DOM state along with a screenshot that includes Set-of-Mark highlight boxes.
     * Uses Canvas API in the browser for GPU-accelerated box drawing.
     * The user NEVER sees the boxes - they're drawn on an in-memory canvas.
     */
    async captureStateWithScreenshot(): Promise<DOMState & { screenshot: string }> {
        // 1. Build DOM tree and set data-blueberry-id attributes (no visual highlights)
        const state = await this.getClickableState(false);

        // 2. Get element boxes AND take screenshot in parallel for speed
        const [elementBoxes, screenshotBuffer] = await Promise.all([
            this.getElementBoxes(),
            this.page.screenshot({ type: 'jpeg', quality: 85, fullPage: false })
        ]);

        // 3. If no boxes, return raw screenshot (fast path)
        if (elementBoxes.length === 0) {
            return { ...state, screenshot: screenshotBuffer.toString('base64') };
        }

        // 4. Use Canvas API in browser to draw boxes (GPU-accelerated, invisible to user)
        const screenshotBase64 = screenshotBuffer.toString('base64');
        const annotatedScreenshot = await this.page.evaluate(
            async ({ imageData, boxes }: { imageData: string; boxes: Array<{ id: string; x: number; y: number; width: number; height: number }> }) => {
                return new Promise<string>((resolve) => {
                    const img = new Image();
                    img.onload = () => {
                        // Create off-screen canvas (invisible to user)
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d')!;

                        // Draw original screenshot
                        ctx.drawImage(img, 0, 0);

                        // Draw boxes on the canvas
                        for (const box of boxes) {
                            // Box fill
                            ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
                            ctx.fillRect(box.x, box.y, box.width, box.height);

                            // Box border
                            ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
                            ctx.lineWidth = 2;
                            ctx.strokeRect(box.x, box.y, box.width, box.height);

                            // Label background
                            const labelText = box.id;
                            const labelWidth = labelText.length * 7 + 6;
                            const labelHeight = 14;
                            ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
                            ctx.fillRect(box.x, box.y, labelWidth, labelHeight);

                            // Label text
                            ctx.fillStyle = 'white';
                            ctx.font = 'bold 10px monospace';
                            ctx.fillText(labelText, box.x + 3, box.y + 11);
                        }

                        // Export as base64 (without data URL prefix)
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                        resolve(dataUrl.replace(/^data:image\/jpeg;base64,/, ''));
                    };
                    img.src = 'data:image/jpeg;base64,' + imageData;
                });
            },
            { imageData: screenshotBase64, boxes: elementBoxes }
        );

        return { ...state, screenshot: annotatedScreenshot };
    }

    /**
     * Get bounding boxes for all elements with data-blueberry-id attributes.
     * Returns positions relative to the viewport.
     */
    private async getElementBoxes(): Promise<ElementBox[]> {
        return await this.page.evaluate(() => {
            const elements = document.querySelectorAll('[data-blueberry-id]');
            const boxes: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];

            elements.forEach((element) => {
                const id = element.getAttribute('data-blueberry-id');
                if (!id) return;

                const rect = element.getBoundingClientRect();

                // Skip elements that are too small or not visible
                if (rect.width < 5 || rect.height < 5) return;
                if (rect.top > window.innerHeight || rect.bottom < 0) return;
                if (rect.left > window.innerWidth || rect.right < 0) return;

                boxes.push({
                    id,
                    x: Math.max(0, Math.round(rect.left)),
                    y: Math.max(0, Math.round(rect.top)),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                });
            });

            return boxes;
        });
    }
}