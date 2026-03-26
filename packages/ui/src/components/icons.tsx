interface LoadingDotProps {
  isLoading: boolean;
  className?: string;
  dotClassName?: string;
}

export function LoadingDot({
  isLoading,
  className,
  dotClassName = "bg-[#307BD0]",
}: LoadingDotProps) {
  return (
    <div className={`relative ${className || ""}`}>
      <style>{`
        @keyframes loading-dot-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      {/* Spinner - visible when loading */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className={`absolute inset-0 w-full h-full transition-[opacity,transform] duration-200 ease-out ${
          isLoading ? "opacity-100 scale-100" : "opacity-0 scale-50"
        }`}
        style={{
          animation: isLoading
            ? "loading-dot-spin 1s linear infinite"
            : undefined,
        }}
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          fill="none"
          opacity={0.2}
        />
        <path
          d="M12 2C6.48 2 2 6.48 2 12"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      {/* Dot - appears when not loading */}
      <div
        className={`absolute inset-0 m-auto w-[80%] h-[80%] rounded-full transition-[opacity,transform] duration-200 ease-out ${dotClassName} ${
          isLoading ? "opacity-0 scale-50" : "opacity-100 scale-100"
        }`}
      />
    </div>
  );
}
