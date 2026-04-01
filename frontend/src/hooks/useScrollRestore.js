import { useEffect } from 'react';

export function useScrollRestore(key) {
  useEffect(() => {
    const savedPosition = sessionStorage.getItem(`scroll-${key}`);
    if (savedPosition) {
      window.scrollTo(0, parseInt(savedPosition, 10));
    }

    const handleScroll = () => {
      sessionStorage.setItem(`scroll-${key}`, window.scrollY.toString());
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [key]);
}
