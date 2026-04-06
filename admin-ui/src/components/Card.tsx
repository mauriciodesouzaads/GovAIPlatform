import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  padding?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
}

const paddingMap = { sm: 'p-3', md: 'p-5', lg: 'p-6' };

export function Card({ children, className = '', hover = false, padding = 'md', onClick }: CardProps) {
  const base = 'bg-card border border-border rounded-xl';
  const hoverClass = hover ? 'hover:border-primary/20 transition-colors duration-150 cursor-pointer' : '';
  const pad = paddingMap[padding];

  return (
    <div
      className={`${base} ${pad} ${hoverClass} ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
