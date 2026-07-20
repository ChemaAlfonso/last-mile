#!/usr/bin/env python3
"""Static file server for local development, WITH HTTP Range support.

Usage:
    python3 tools/dev_server.py            # serves the repo root on http://localhost:8000
    python3 tools/dev_server.py 8080       # ... on port 8080

Same shape as `python3 -m http.server <port>`, but Python's built-in server does
NOT honour Range requests. The offline vector basemap (data/basemap-comarca.pmtiles)
is read with HTTP byte-range requests by protomaps-leaflet / pmtiles, so the plain
http.server returns the whole file for every tile and the map never renders locally.
This handler answers single `Range: bytes=start-end` requests with a 206 response.

Standard library only. For production, nginx already serves byte ranges by default
(see docs/offline-map.md) -- this script is dev-only.
"""

import os
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class RangeRequestHandler(SimpleHTTPRequestHandler):
	"""SimpleHTTPRequestHandler that understands a single-range Range header."""

	def end_headers(self):
		# Advertise range support on every response so clients attempt ranged reads.
		self.send_header('Accept-Ranges', 'bytes')
		super().end_headers()

	def send_head(self):
		range_header = self.headers.get('Range')
		if not range_header:
			return super().send_head()

		try:
			unit, _, spec = range_header.partition('=')
			if unit.strip().lower() != 'bytes' or ',' in spec:
				# Multi-range or unknown unit: fall back to the full body.
				return super().send_head()
			start_text, _, end_text = spec.strip().partition('-')
		except ValueError:
			return super().send_head()

		path = self.translate_path(self.path)
		if os.path.isdir(path):
			return super().send_head()
		try:
			handle = open(path, 'rb')
		except OSError:
			self.send_error(HTTPStatus.NOT_FOUND, 'File not found')
			return None

		file_size = os.fstat(handle.fileno()).st_size
		try:
			if start_text == '':
				# Suffix range: last N bytes.
				length = int(end_text)
				start = max(0, file_size - length)
				end = file_size - 1
			else:
				start = int(start_text)
				end = int(end_text) if end_text else file_size - 1
		except ValueError:
			handle.close()
			return super().send_head()

		if start >= file_size or start > end:
			handle.close()
			self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
			self.send_header('Content-Range', 'bytes */%d' % file_size)
			self.end_headers()
			return None

		end = min(end, file_size - 1)
		self._range = (start, end)
		self.send_response(HTTPStatus.PARTIAL_CONTENT)
		self.send_header('Content-Type', self.guess_type(path))
		self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, file_size))
		self.send_header('Content-Length', str(end - start + 1))
		self.end_headers()
		handle.seek(start)
		return handle

	def copyfile(self, source, outputfile):
		span = getattr(self, '_range', None)
		if span is None:
			return super().copyfile(source, outputfile)
		start, end = span
		self._range = None
		remaining = end - start + 1
		chunk = 64 * 1024
		while remaining > 0:
			data = source.read(min(chunk, remaining))
			if not data:
				break
			outputfile.write(data)
			remaining -= len(data)


def main():
	port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
	handler = partial(RangeRequestHandler, directory=REPO_ROOT)
	server = ThreadingHTTPServer(('0.0.0.0', port), handler)
	print('Serving %s with Range support at http://localhost:%d/' % (REPO_ROOT, port))
	print('Ctrl-C to stop.')
	try:
		server.serve_forever()
	except KeyboardInterrupt:
		print('\nStopped.')


if __name__ == '__main__':
	main()
