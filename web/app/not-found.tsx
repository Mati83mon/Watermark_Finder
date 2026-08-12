import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted">That URL does not exist in this application.</p>
      <Link href="/" className="link mt-3 inline-block">
        Back to the dashboard →
      </Link>
    </div>
  );
}
