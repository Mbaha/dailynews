'use client';

import { useEffect, useState } from 'react';

export function PdfViewer({ src }: { src: string }) {
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    setIsIos(/iPad|iPhone|iPod/.test(navigator.userAgent));
  }, []);

  if (isIos) {
    return (
      <div className="pdfIosFallback">
        <p>PDFs cannot be embedded in Safari on iPad.</p>
        <a href={src} target="_blank" rel="noopener noreferrer" className="pdfOpenBtn">
          Open PDF in Safari
        </a>
      </div>
    );
  }

  return <iframe title="Newspaper PDF reader" src={src} />;
}
