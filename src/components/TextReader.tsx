type Props = {
  text: string | null;
  pdfHref: string;
};

export function TextReader({ text, pdfHref }: Props) {
  if (!text) {
    return (
      <div className="textReaderEmpty">
        <p>No text available for this page.</p>
        <a className="textReaderPdfLink" href={pdfHref} target="_blank" rel="noopener noreferrer">View page as PDF ↗</a>
      </div>
    );
  }

  const paragraphs = text.split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);

  return (
    <div className="textReader">
      <div className="textReaderBody">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      <div className="textReaderFooter">
        <a className="textReaderPdfLink" href={pdfHref} target="_blank" rel="noopener noreferrer">View page as PDF ↗</a>
      </div>
    </div>
  );
}
