import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "PrivateTip — Confidential tipping on Flow";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background:
            "linear-gradient(135deg, #0a0a0f 0%, #1a0a2a 50%, #0a0a0f 100%)",
          color: "white",
          fontFamily: "sans-serif",
          padding: "80px",
          position: "relative",
        }}
      >
        {/* Janus glyph — top right */}
        <div
          style={{
            position: "absolute",
            top: "70px",
            right: "80px",
            width: "100px",
            height: "100px",
            borderRadius: "50%",
            border: "3px solid #a78bfa",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#0a0a0f",
          }}
        >
          <div
            style={{
              width: "3px",
              height: "90px",
              background:
                "linear-gradient(180deg, #a78bfa 0%, #fbbf24 100%)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "28px",
              width: "12px",
              height: "12px",
              borderRadius: "50%",
              background: "#a78bfa",
            }}
          />
          <div
            style={{
              position: "absolute",
              right: "28px",
              width: "12px",
              height: "12px",
              borderRadius: "50%",
              background: "#fbbf24",
            }}
          />
        </div>

        {/* Top label */}
        <div
          style={{
            display: "flex",
            fontSize: "26px",
            color: "#a78bfa",
            letterSpacing: "5px",
            textTransform: "uppercase",
            marginBottom: "30px",
          }}
        >
          A Janus stack demo
        </div>

        {/* Main title */}
        <div
          style={{
            display: "flex",
            fontSize: "140px",
            fontWeight: 800,
            lineHeight: 1,
            marginBottom: "32px",
            letterSpacing: "-3px",
          }}
        >
          PrivateTip
        </div>

        {/* Subtitle */}
        <div
          style={{
            display: "flex",
            fontSize: "48px",
            color: "#e5e7eb",
            marginBottom: "20px",
            lineHeight: 1.2,
            fontWeight: 400,
          }}
        >
          Confidential tipping on Flow
        </div>

        {/* Tagline */}
        <div
          style={{
            display: "flex",
            fontSize: "28px",
            color: "#9ca3af",
            marginBottom: "auto",
            lineHeight: 1.3,
          }}
        >
          Amounts hidden on-chain via Pedersen + Groth16
        </div>

        {/* Bottom row */}
        <div
          style={{
            display: "flex",
            gap: "32px",
            fontSize: "26px",
            color: "#9ca3af",
            alignItems: "center",
            marginTop: "40px",
          }}
        >
          <div style={{ display: "flex", color: "#fbbf24" }}>● Testnet</div>
          <div style={{ display: "flex" }}>·</div>
          <div style={{ display: "flex" }}>Privacy, not anonymity</div>
          <div style={{ display: "flex" }}>·</div>
          <div style={{ display: "flex" }}>Audit in progress</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
