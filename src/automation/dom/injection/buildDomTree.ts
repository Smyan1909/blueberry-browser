
interface ElementData {
    nodeId: number;
    tagName: string;
    attributes: Record<string, string>;
    text?: string;
    isInteractive: boolean;
    isVisible: boolean;
    rect: DOMRect;
    parentId?: number;
    children?: ElementData[];
}

let nodeIdCounter = 0;

const nodeMap = new Map<number, Element>();

export function buildDomTree(doHighlight: boolean = false): any {
    nodeIdCounter = 0;
    nodeMap.clear();

    if (document.getElementById('blueberry-highlight-container')) {
        document.getElementById('blueberry-highlight-container')!.remove();
    }

    const root = document.body;
    if (!root) {
        return { tree: null, mapCount: 0 };
    }

    const simplifiedTree = recursiveTraverse(root);

    if (doHighlight) {
        drawHighlights();
    }

    return {
        tree: simplifiedTree,

        mapCount: nodeMap.size
    }
}

function recursiveTraverse(node: Element, parentId?: number): ElementData | null {
    if (!node) return null;

    const nodeId = typeof node.getAttribute === 'function' ? node.getAttribute('id') : null;
    if (nodeId && typeof nodeId === 'string' && (
        nodeId === 'blueberry-spectator-overlay' ||
        nodeId === 'blueberry-cursor' ||
        nodeId === 'blueberry-highlight-container' ||
        nodeId.startsWith('blueberry-')
    )) {
        return null;
    }

    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);

    const isVisible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0;

    if (!isVisible) return null;

    // Skip elements entirely outside viewport (not useful for current view)
    const inViewport =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;

    // Skip elements too small to interact with (less than 10x10)
    const isTooSmall = rect.width < 10 || rect.height < 10;

    if (!inViewport || isTooSmall) return null;

    const isInteractive = checkInteractivity(node, style);

    let rawChildren = Array.from(node.children);
    if (node.shadowRoot) {
        rawChildren = [...rawChildren, ...Array.from(node.shadowRoot.children)];
    }

    const childrenData: ElementData[] = [];

    const currentId = ++nodeIdCounter;
    nodeMap.set(currentId, node);

    node.setAttribute('data-blueberry-id', currentId.toString());

    for (const child of Array.from(node.children)) {
        const childResult = recursiveTraverse(child, currentId);
        if (childResult) {
            childrenData.push(childResult);
        }
    }

    let text = '';


    if (isInteractive) {
        // For buttons/links, we usually want the full cleaner label
        text = node.textContent || '';
    } else {
        // For containers, we only want "own" text to avoid duplicating children's text
        node.childNodes.forEach(child => {
            if (child.nodeType === Node.TEXT_NODE) {
                text += child.nodeValue || '';
            }
        });
    }


    if (!isInteractive && childrenData.length === 0 && text.length === 0) return null;


    const MAX_TEXT = 6000;
    if (text.length > MAX_TEXT) {
        text = text.substring(0, MAX_TEXT) + '...[truncated]';
    }

    return {
        nodeId: currentId,
        tagName: node.tagName.toLowerCase(),
        attributes: getRelevantAttributes(node),
        text: text,
        isInteractive,
        isVisible,
        rect: {
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left
        } as any,
        parentId,
        children: childrenData.length > 0 ? childrenData : undefined,
    };

}

function checkInteractivity(node: Element, style: CSSStyleDeclaration): boolean {
    const tagName = node.tagName.toLowerCase();


    if (['button', 'a', 'input', 'select', 'textarea', 'details', 'summary'].includes(tagName)) return true;


    const role = node.getAttribute('role');
    if (['button', 'link', 'menuitem', 'checkbox', 'radio', 'tab', 'combobox', 'textbox', 'switch'].includes(role || '')) return true;


    if (node.hasAttribute('onclick') || node.hasAttribute('ng-click') || node.hasAttribute('@click')) return true;

    if (style.cursor === 'pointer' || style.cursor === 'hand') return true;

    if (tagName === 'label') return true;

    if (tagName.startsWith('ytd-') || tagName.startsWith('ytm-')) {
        const ariaLabel = node.getAttribute('aria-label');
        if (ariaLabel && (ariaLabel.toLowerCase().includes('video') || ariaLabel.toLowerCase().includes('watch'))) {
            return true;
        }
        if (tagName.includes('thumbnail') || tagName.includes('video')) {
            return true;
        }
    }


    const id = typeof node.getAttribute === 'function' ? node.getAttribute('id') || '' : '';
    const className = node.className && typeof node.className === 'string' ? node.className : '';
    const ariaLabel = node.getAttribute('aria-label') || '';


    const videoKeywords = ['video', 'thumbnail', 'play-button', 'player', 'watch'];
    const combined = (id + ' ' + className + ' ' + ariaLabel).toLowerCase();
    if (videoKeywords.some(kw => combined.includes(kw)) && style.cursor !== 'default') {
        return true;
    }

    // Images can be clickable (thumbnails, video previews)
    if (tagName === 'img') {
        // If image has alt text suggesting it's a video thumbnail
        const alt = node.getAttribute('alt') || '';
        if (alt.toLowerCase().includes('video') || alt.toLowerCase().includes('thumbnail')) {
            return true;
        }
    }

    return false;
}

function getRelevantAttributes(node: Element): Record<string, string> {
    const attrs: Record<string, string> = {};

    const core = ['id', 'class', 'name', 'type', 'placeholder', 'title', 'alt', 'href', 'src'];

    // Properties that should be read from the live DOM object, not attributes
    const liveProps = ['value', 'checked', 'selected', 'disabled', 'readonly'];

    const states = [
        'role',
        'aria-label', 'aria-labelledby', 'aria-describedby',
        'aria-hidden', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-disabled'
    ];


    [...core, ...states].forEach(attr => {
        if (node.hasAttribute(attr)) {
            attrs[attr] = node.getAttribute(attr) || '';
        }
    });

    liveProps.forEach(prop => {
        if (prop in node) {
            const val = (node as any)[prop];
            // Only add if truthy or explicitly false (for booleans)
            if (val === true) attrs[prop] = 'true';
            if (val === false) attrs[prop] = 'false';
            if (typeof val === 'string' && val.length > 0) attrs[prop] = val;
        }
    });

    return attrs;
}


function drawHighlights() {
    const container = document.createElement('div');
    container.id = 'blueberry-highlight-container';
    Object.assign(container.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none', // Click through
        zIndex: '2147483647', // Max z-index
    });

    nodeMap.forEach((node, id) => {

        const rect = node.getBoundingClientRect();

        if (rect.width === 0 || rect.height === 0) return;

        const box = document.createElement('div');
        Object.assign(box.style, {
            position: 'absolute',
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            border: '2px solid rgba(255, 0, 0, 0.6)',
            backgroundColor: 'rgba(255, 0, 0, 0.05)',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'start',
            justifyContent: 'start'
        });

        const label = document.createElement('span');
        label.textContent = id.toString();
        Object.assign(label.style, {
            backgroundColor: 'red',
            color: 'white',
            fontSize: '10px',
            padding: '1px 3px',
            fontWeight: 'bold'
        });

        box.appendChild(label);
        container.appendChild(box);
    });

    document.body.appendChild(container);
}