export interface ButtonProps {
  children?: React.ReactNode;
  size?: '2xs' | 'xs' | 'sm' | 'md';
  variant?: 'muted' | 'primary' | 'warning' | 'danger' | 'transparent';
}

export function Button({children, ...props}: ButtonProps) {
  return (
    <button style={{color: 'red'}}>
      {JSON.stringify(props)}
      {children}
    </button>
  );
}
