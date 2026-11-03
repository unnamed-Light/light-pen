import type { ReactNode } from "react";
import type { Tool } from "../editor/model/types";

export function ToolIcon({ tool }: { tool: Tool }) {
  const paths: Record<Tool, ReactNode> = {
    select: <path d="m6 3 13 10-7 1-4 7z" />,
    hand: (
      <path d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v6c0 4-2 7-6 7h-1c-2 0-4-1-5-3l-4-6a1.5 1.5 0 0 1 2-2l2 2" />
    ),
    pen: (
      <>
        <path d="m5 19 2-7L17 2a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L12 17zM15 4l5 5" />
        <path d="M3 22h18" />
      </>
    ),
    highlighter: (
      <>
        <path d="m5 14 9-10 6 6-9 10zM5 14l-2 5 3 3 5-2" />
        <path d="M14 4l2-2 6 6-2 2M3 22h18" />
      </>
    ),
    eraser: (
      <>
        <path d="m4 14 10-11a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3L12 21H9l-5-4a2 2 0 0 1 0-3zM10 8l9 8" />
        <path d="M12 21h10" />
      </>
    ),
    rectangle: <rect x="3" y="5" width="18" height="14" rx="2" />,
    ellipse: <ellipse cx="12" cy="12" rx="9" ry="8" />,
    diamond: <path d="m12 2 10 10-10 10L2 12z" />,
    arrow: <path d="M4 20 20 4M7 4h13v13" />,
    line: <path d="M4 20 20 4" />,
    connector: (
      <>
        <rect x="2" y="3" width="6" height="6" rx="1" />
        <rect x="16" y="15" width="6" height="6" rx="1" />
        <path d="M8 6h4v12h4m-3-3 3 3-3 3" />
      </>
    ),
    frame: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="1" strokeDasharray="3 2" />
        <path d="M4 9h16" />
      </>
    ),
    math: <path d="M19 4H7l7 8-7 8h12M4 4h1m-1 16h1" />,
    table: <path d="M3 4h18v16H3zM3 10h18M3 15h18M9 4v16M15 4v16" />,
    task: <path d="M4 4h16v17H4zM8 9l2 2 5-5M8 15h8M8 18h5" />,
    link: (
      <path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" />
    ),
    text: <path d="M4 5V3h16v2M12 3v18M8 21h8" />,
    sticky: (
      <>
        <path d="M4 3h16a1 1 0 0 1 1 1v10l-7 7H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
        <path d="M14 21v-7h7" />
      </>
    ),
  };
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[tool]}
    </svg>
  );
}
