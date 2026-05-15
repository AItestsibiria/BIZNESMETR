import { useEffect, useRef, useState } from "react";
import QRCodeStyling from "qr-code-styling";
import { Download, Copy, Check, Share2 } from "lucide-react";

function createQR(url: string, size = 280) {
  return new QRCodeStyling({
    width: size,
    height: size,
    margin: Math.round(size * 0.06),
    type: "svg",
    data: url,
    dotsOptions: {
      color: "#1a1a2e",
      type: "rounded",
      gradient: {
        type: "linear",
        rotation: 45,
        colorStops: [
          { offset: 0, color: "#4c1d95" },
          { offset: 1, color: "#1e3a5f" },
        ],
      },
    },
    cornersSquareOptions: {
      type: "extra-rounded",
      color: "#4c1d95",
    },
    cornersDotOptions: {
      type: "dot",
      color: "#3b0764",
    },
    backgroundOptions: {
      color: "#ffffff",
    },
    qrOptions: {
      errorCorrectionLevel: "H",
    },
  });
}

/** Draw MuzaAi logo (white circle + gradient rounded square + wave) on canvas at center */
function drawLogo(ctx: CanvasRenderingContext2D, size: number) {
  const cx = size / 2, cy = size / 2;
  const logoSize = Math.round(size * 0.15); // 15% of QR size
  const pad = Math.round(logoSize * 0.12);

  // White circle background
  ctx.beginPath();
  ctx.arc(cx, cy, logoSize / 2 + pad, 0, Math.PI * 2);
  ctx.fillStyle = "white";
  ctx.fill();

  // Gradient rounded square
  const grad = ctx.createLinearGradient(
    cx - logoSize / 2, cy - logoSize / 2,
    cx + logoSize / 2, cy + logoSize / 2
  );
  grad.addColorStop(0, "#7c3aed");
  grad.addColorStop(0.5, "#8b5cf6");
  grad.addColorStop(1, "#3b82f6");

  const r2 = Math.round(logoSize * 0.17);
  const x1 = cx - logoSize / 2, y1 = cy - logoSize / 2;
  const x2 = cx + logoSize / 2, y2 = cy + logoSize / 2;
  ctx.beginPath();
  ctx.moveTo(x1 + r2, y1);
  ctx.lineTo(x2 - r2, y1); ctx.quadraticCurveTo(x2, y1, x2, y1 + r2);
  ctx.lineTo(x2, y2 - r2); ctx.quadraticCurveTo(x2, y2, x2 - r2, y2);
  ctx.lineTo(x1 + r2, y2); ctx.quadraticCurveTo(x1, y2, x1, y2 - r2);
  ctx.lineTo(x1, y1 + r2); ctx.quadraticCurveTo(x1, y1, x1 + r2, y1);
  ctx.fillStyle = grad;
  ctx.fill();

  // Wave
  const waveWidth = logoSize * 0.67;
  const waveAmp = logoSize * 0.14;
  const lineW = Math.max(1.5, logoSize * 0.06);
  ctx.strokeStyle = "white";
  ctx.lineWidth = lineW;
  ctx.lineCap = "round";
  ctx.beginPath();
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const wx = cx - waveWidth / 2 + t * waveWidth;
    const wy = cy + Math.sin(t * Math.PI * 3.5) * waveAmp * Math.sin(t * Math.PI);
    i === 0 ? ctx.moveTo(wx, wy) : ctx.lineTo(wx, wy);
  }
  ctx.stroke();
}

/** Render QR code with embedded MuzaAi logo as a PNG blob */
async function renderQRWithLogo(url: string, size: number): Promise<Blob | null> {
  const qr = createQR(url, size);
  const blob = await qr.getRawData("png");
  if (!blob) return null;

  const qrUrl = URL.createObjectURL(blob);
  const qrImg = new Image();
  qrImg.src = qrUrl;
  await new Promise(r => { qrImg.onload = r; });

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Draw QR
  ctx.drawImage(qrImg, 0, 0, size, size);
  URL.revokeObjectURL(qrUrl);

  // Draw logo on top
  drawLogo(ctx, size);

  // Convert to blob
  return new Promise(resolve => {
    canvas.toBlob(b => resolve(b), "image/png");
  });
}

export function ShareQRSection() {
  const qrRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!qrRef.current) return;
    qrRef.current.innerHTML = "";

    renderQRWithLogo("https://muziai.ru", 240).then(finalBlob => {
      if (!finalBlob || !qrRef.current) return;
      const finalUrl = URL.createObjectURL(finalBlob);
      const img = document.createElement("img");
      img.src = finalUrl;
      img.width = 240;
      img.height = 240;
      img.alt = "MuzaAi QR";
      img.style.borderRadius = "12px";
      qrRef.current!.appendChild(img);
    }).catch(() => {
      // Fallback: render without logo
      const qr = createQR("https://muziai.ru", 240);
      qr.append(qrRef.current!);
    });
  }, []);

  const handleCopy = async () => {
    await navigator.clipboard.writeText("https://muziai.ru");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyQR = async () => {
    try {
      const blob = await renderQRWithLogo("https://muziai.ru", 600);
      if (blob) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      }
    } catch {}
    // Fallback: copy link
    await navigator.clipboard.writeText("https://muziai.ru");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = async () => {
    try {
      const blob = await renderQRWithLogo("https://muziai.ru", 600);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "MuzaAi-QR.png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return;
      }
    } catch {}
    // Fallback
    const qr = createQR("https://muziai.ru", 600);
    qr.download({ name: "MuzaAi-QR", extension: "png" });
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        const blob = await renderQRWithLogo("https://muziai.ru", 600);
        if (blob) {
          const file = new File([blob], "MuzaAi-QR.png", { type: "image/png" });
          await navigator.share({
            title: "MuzaAi — AI Music",
            text: "Создавай музыку, тексты и обложки с помощью AI. Дарим 1000 ₽ по промокоду «Поехали»!",
            url: "https://muziai.ru",
            files: [file],
          });
          return;
        }
      } catch {}
      // Fallback without file
      try {
        await navigator.share({
          title: "MuzaAi — AI Music",
          text: "Создавай музыку, тексты и обложки с помощью AI. Дарим 1000 ₽ по промокоду «Поехали»!",
          url: "https://muziai.ru",
        });
      } catch {}
    } else {
      handleCopy();
    }
  };

  return (
    <section className="relative z-[1] py-16 px-4 border-t border-white/[0.04]">
      <div className="max-w-2xl mx-auto text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-600 via-violet-500 to-blue-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none">
              <path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <span className="text-xl font-bold tracking-tight"><span className="bg-gradient-to-r from-purple-400 via-violet-300 to-blue-400 bg-clip-text text-transparent">Muzi</span><span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">Ai</span></span>
        </div>
        <p className="text-muted-foreground text-sm mb-8">
          Покажите друзьям — отсканируйте QR-код или скопируйте
        </p>

        <div className="inline-flex flex-col items-center">
          {/* QR Card — logo is baked into the canvas image, no CSS overlay needed */}
          <div className="relative p-6 rounded-2xl bg-white border border-gray-200 shadow-2xl shadow-purple-500/10">
            {/* Glow */}
            <div className="absolute -inset-1 rounded-2xl bg-gradient-to-br from-purple-500/10 via-transparent to-blue-500/10 blur-xl pointer-events-none" />
            
            <div className="relative">
              <div ref={qrRef} className="flex items-center justify-center" />
            </div>

            <div className="flex items-center justify-center gap-2 mt-4">
              <div className="w-5 h-5 rounded bg-gradient-to-br from-purple-600 via-violet-500 to-blue-500 flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none"><path d="M3 12c1.5-3 3-5 4.5-3s2 4 3.5 2 2.5-5 4-3 2 4 3.5 2 2.5-4 3.5-2" stroke="white" strokeWidth="3" strokeLinecap="round" /></svg>
              </div>
              <span className="text-sm font-bold tracking-tight"><span style={{background:'linear-gradient(to right,#8b5cf6,#6366f1)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent'}}>Muzi</span><span style={{background:'linear-gradient(to right,#3b82f6,#06b6d4)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent'}}>Ai</span><span className="text-purple-700">.ru</span></span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 mt-6">
            <button
              onClick={handleCopyQR}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium border border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Скопировано" : "Копировать QR"}
            </button>

            <button
              onClick={handleCopy}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium border border-white/10 bg-white/5 text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
              Ссылка
            </button>

            <button
              onClick={handleDownload}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Скачать QR
            </button>

            <button
              onClick={handleShare}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition-colors"
            >
              <Share2 className="w-3.5 h-3.5" />
              Поделиться
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Compact QR for track share dialog */
export function TrackShareQR({ trackId, title }: { trackId: number; title: string }) {
  const qrRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const shareUrl = `https://muziai.ru/share/${trackId}`;

  useEffect(() => {
    if (!qrRef.current) return;
    qrRef.current.innerHTML = "";

    renderQRWithLogo(shareUrl, 180).then(finalBlob => {
      if (!finalBlob || !qrRef.current) return;
      const finalUrl = URL.createObjectURL(finalBlob);
      const img = document.createElement("img");
      img.src = finalUrl;
      img.width = 180;
      img.height = 180;
      img.alt = `QR ${title}`;
      img.style.borderRadius = "8px";
      qrRef.current!.appendChild(img);
    }).catch(() => {
      const qr = createQR(shareUrl, 180);
      qr.append(qrRef.current!);
    });
  }, [shareUrl]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = async () => {
    try {
      const blob = await renderQRWithLogo(shareUrl, 600);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `MuzaAi-track-${trackId}-QR.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return;
      }
    } catch {}
    const qr = createQR(shareUrl, 600);
    qr.download({ name: `track-${trackId}-qr`, extension: "png" });
  };

  return (
    <div className="flex flex-col items-center gap-3 p-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
      <div className="relative">
        <div ref={qrRef} className="flex items-center justify-center" />
      </div>
      <p className="text-xs text-muted-foreground text-center truncate max-w-[180px]">{title}</p>
      <div className="flex items-center gap-2">
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border border-white/10 bg-white/5 text-muted-foreground hover:text-white transition-colors"
        >
          {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          {copied ? "Скопировано" : "Копировать"}
        </button>
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 transition-colors"
        >
          <Download className="w-3 h-3" />
          QR
        </button>
      </div>
    </div>
  );
}
