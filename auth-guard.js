// Authentication Guard - Include this script first on all protected pages
(function() {
    'use strict';
    
    // Normalize current page path: remove trailing slashes (except root)
    const normalizePath = (p) => {
        if (!p) return '/';
        if (p !== '/' && p.endsWith('/')) return p.replace(/\/+$/, '');
        return p;
    };
    const currentPath = normalizePath(window.location.pathname);
    
    // Pages that don't require authentication (support friendly URLs)
    const publicPages = new Set([
      '/', '/landing.html', '/landing',
      '/auth.html', '/auth',
      '/pricing.html', '/pricing',
      '/inspiration.html', '/inspiration'
    ]);
    
    // Check if current page is public
    const isPublicPage = publicPages.has(currentPath);
    
    // Check authentication immediately
    function checkAuth() {
        const token = localStorage.getItem('authToken');
        if (!token && !isPublicPage) {
            // Only redirect to auth if this is a protected page
            window.location.href = '/auth.html';
            return false;
        }
        return true;
    }
    
    // Only run authentication check for protected pages
    if (!isPublicPage) {
        if (!checkAuth()) {
            // Stop all script execution if not authenticated
            throw new Error('Authentication required - redirecting to login');
        }
    }
    
    // Make auth check available globally
    window.checkAuth = checkAuth;
    
    // Check auth on page visibility change (prevents back button bypass)
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden && !isPublicPage) {
            checkAuth();
        }
    });
    
})();
