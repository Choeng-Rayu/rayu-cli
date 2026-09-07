import type { JSX, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function SparkleIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M8 0a1 1 0 0 1 .92.61l1.39 3.48a4.5 4.5 0 0 0 2.6 2.6l3.48 1.39a1 1 0 0 1 0 1.84l-3.48 1.39a4.5 4.5 0 0 0-2.6 2.6L8.92 15.39a1 1 0 0 1-1.84 0l-1.39-3.48a4.5 4.5 0 0 0-2.6-2.6L.61 8.92a1 1 0 0 1 0-1.84l3.48-1.39a4.5 4.5 0 0 0 2.6-2.6L7.08.61A1 1 0 0 1 8 0z" />
    </svg>
  );
}

export function UserIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 1c-3.31 0-6 2.02-6 4.5V15h12v-1.5C14 11.02 11.31 9 8 9z" />
    </svg>
  );
}

export function CopyIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M4 4h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0-2h6a1 1 0 0 1 1 1v1H3V3a1 1 0 0 1 1-1zm-2 4h1v7a2 2 0 0 0 2 2h6v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6z" />
    </svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z" />
    </svg>
  );
}

export function DiffIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M8 1a.5.5 0 0 1 .5.5V7h5.5a.5.5 0 0 1 0 1H8.5v5.5a.5.5 0 0 1-1 0V8H2a.5.5 0 0 1 0-1h5.5V1.5A.5.5 0 0 1 8 1z" />
    </svg>
  );
}

export function CompareIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h4A1.5 1.5 0 0 1 8 2.5v11A1.5 1.5 0 0 1 6.5 15h-4A1.5 1.5 0 0 1 1 13.5v-11zm8 0A1.5 1.5 0 0 1 10.5 1h4a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-11zM7 2.5a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5v-11zm8 0a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5v-11z" />
    </svg>
  );
}

export function UndoIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M2.146 6.354a.5.5 0 0 1 0-.708l3-3a.5.5 0 1 1 .708.708L3.707 5.5H10.5a4.5 4.5 0 0 1 4.5 4.5v3.5a.5.5 0 0 1-1 0V10a3.5 3.5 0 0 0-3.5-3.5H3.707l2.147 2.146a.5.5 0 0 1-.708.708l-3-3z" />
    </svg>
  );
}

export function CheckAllIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M12.354 4.354a.5.5 0 0 0-.708-.708L5 10.293 1.854 7.146a.5.5 0 1 0-.708.708l3.5 3.5a.5.5 0 0 0 .708 0l7-7zm2.5 0a.5.5 0 0 0-.708-.708L7.5 10.293l-.646-.647a.5.5 0 1 0-.708.708l1 1a.5.5 0 0 0 .708 0l7-7z" />
    </svg>
  );
}

export function SendIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M15.854.146a.5.5 0 0 1 .11.54l-5.8 14.5a.5.5 0 0 1-.928 0l-2.71-6.775-6.775-2.71a.5.5 0 0 1 0-.928L14.207.036a.5.5 0 0 1 .54.11zM7.22 8.78l1.865 4.662 4.646-11.616-11.616 4.646 4.662 1.865.443.443z" />
    </svg>
  );
}

export function ArrowUpIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M8 15a.5.5 0 0 0 .5-.5V2.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 1 0 .708.708L7.5 2.707V14.5a.5.5 0 0 0 .5.5z" />
    </svg>
  );
}

export function StopIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="10" height="10" rx="2" />
    </svg>
  );
}

export function TerminalIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3zm2 2.5a.5.5 0 0 0-.708.708L5.086 8l-1.794 1.794a.5.5 0 0 0 .708.708l2.147-2.148a.5.5 0 0 0 0-.708L4 5.5zm4 4.5a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H8z" />
    </svg>
  );
}

export function EditIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5L13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175l-.886 2.216 2.216-.886L3.032 10.675z" />
    </svg>
  );
}

export function FileIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6L9 1zm4 13H3V2h5v4h5v8z" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z" />
    </svg>
  );
}

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M8 0c-.8 0-6 2.67-6 4v5.33C2 13.07 4.8 15.6 8 16c3.2-.4 6-2.93 6-6.67V4c0-1.33-5.2-4-6-4zm0 1.2c.7.35 4.5 2.25 5 2.63v5.5c0 3.03-2.3 5.09-5 5.47-2.7-.38-5-2.44-5-5.47v-5.5c.5-.38 4.3-2.28 5-2.63z" />
    </svg>
  );
}
