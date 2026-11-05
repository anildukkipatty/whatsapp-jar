"use client";

export function LoginButton(props: { userId: number; name: string; tenantName: string }) {
  async function signIn() {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: props.userId, timeZone }),
    });
    if (response.ok) window.location.href = "/";
  }
  return (
    <button onClick={signIn}>
      <strong>{props.name}</strong>
      <span>{props.tenantName}</span>
    </button>
  );
}
