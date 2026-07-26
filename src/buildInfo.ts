// Which build is actually running.
//
// WKWebView keeps the previous JavaScript across a native rebuild unless the app
// is force-quit and relaunched, and on the web a service worker pins the shell.
// So "I tested it and it is still broken" is ambiguous unless the app can say
// which bundle it is. It cost two misfiled bug reports before this existed;
// quote this string in any future one.
declare const __BUILD_ID__: string;
declare const __BUILT_AT__: string;

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
export const BUILT_AT: string = typeof __BUILT_AT__ === 'string' ? __BUILT_AT__ : '';
