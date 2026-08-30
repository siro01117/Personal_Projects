// 모듈 전환 중 즉시 보이는 골격. 이게 없으면 서버 응답이 올 때까지
// 이전 화면이 그대로 멈춰 있어서 "먹통"처럼 느껴진다.
export default function ModuleLoading() {
  const bar: React.CSSProperties = {
    background: "var(--panel2)",
    borderRadius: 8,
    animation: "sq-pulse 1.1s ease-in-out infinite",
  };
  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <style>{`@keyframes sq-pulse{0%,100%{opacity:.45}50%{opacity:.9}}`}</style>

      {/* 헤더 자리 */}
      <div
        style={{
          borderBottom: "1px solid var(--line)",
          background: "var(--card)",
          height: 56,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 20px",
          flex: "none",
        }}
      >
        <div style={{ ...bar, width: 54, height: 26 }} />
        <div style={{ ...bar, width: 110, height: 16 }} />
        <div style={{ ...bar, width: 64, height: 22, marginLeft: 4 }} />
      </div>

      {/* 본문 자리 */}
      <div style={{ flex: 1, padding: 28, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, alignContent: "start", maxWidth: 980, margin: "0 auto", width: "100%" }}>
        <div style={{ ...bar, gridColumn: "span 2", height: 176 }} />
        <div style={{ ...bar, height: 82 }} />
        <div style={{ ...bar, height: 82 }} />
        <div style={{ ...bar, gridColumn: "span 2", height: 82 }} />
        <div style={{ ...bar, gridColumn: "span 2", height: 82 }} />
        <div style={{ ...bar, gridColumn: "span 4", height: 150 }} />
      </div>
    </main>
  );
}
