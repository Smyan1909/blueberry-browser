export { };

declare global {
    interface Window {
        trustedTypes?: {
            createPolicy: (name: string, rules: any) => any;
            defaultPolicy?: any;
        };
        blueberryPolicy?: any;
        blueberryVideoObserver?: MutationObserver;
    }
}
