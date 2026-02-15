/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Env {
	ALBUM_URL?: string;
	ALLOW_ORIGIN?: string;
	CACHE_CONTROL?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		switch (request.method) {
			case 'GET':
				return handleGet(request, env);
			case 'OPTIONS':
				return handleOptions(env);
			default:
				return new Response(null, { status: 405 });
		}
	},
};

const handleGet = async (request: Request, env: Env): Promise<Response> => {
	// Coba ambil dari query parameter dulu
	const url = new URL(request.url);
	let albumUrl = url.searchParams.get('url')?.trim();
	
	// Kalo ga ada parameter url, pake env variable
	if (!albumUrl) {
		albumUrl = env.ALBUM_URL?.trim();
	}
	
	// Handle kalo user masukin short code aja (7QzAnueaCVnrQdiG7)
	if (albumUrl && !albumUrl.startsWith('http')) {
		// Asumsinya ini short code dari photos.app.goo.gl
		albumUrl = `https://photos.app.goo.gl/${albumUrl}`;
	}

	if (!albumUrl) {
		return jsonResponse(
			{ error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable' }, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}

	try {
		// Fetch dengan follow redirect (short link bakal di-redirect ke URL panjang)
		const resp = await fetch(`${albumUrl}?_imcp=1`, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; Google-Photos-Worker/1.0)'
			}
		});
		
		if (!resp.ok) {
			return jsonResponse(
				{ error: `Failed to fetch album: ${resp.status}` }, 
				{ status: 502, allowOrigin: env.ALLOW_ORIGIN }
			);
		}
		
		const text = await resp.text();

		// Ambil judul album dari meta tag
		const titleMatch = text.match(/<title>([^<]+) - Google Photos<\/title>/);
		let albumTitle = titleMatch ? titleMatch[1].trim() : 'Untitled Album';
		
		// Fallback ke meta tag lain kalo ga ketemu
		if (!titleMatch) {
			const ogTitleMatch = text.match(/<meta property="og:title" content="([^"]+)"\/?>/);
			albumTitle = ogTitleMatch ? ogTitleMatch[1].trim() : 'Untitled Album';
		}

		// Regex untuk ambil semua foto - improved version
		const photoRegex = /\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_\-\.]+)",(\d+),(\d+)[^\]]+\](?:[^\[]*\[(?:[^\]]*)\])*?[^\]]*\]\],(\d+),(\d+),(\d+)/g;
		
		const matches = [...text.matchAll(photoRegex)];
		
		const images = matches.flatMap(([, url, width, height, timestamp1, timestamp2, timestamp3]) => {
			if (!url || !width || !height) {
				return [];
			}

			// Ambil timestamp yang valid (biasanya yang terakhir)
			const timestamps = [timestamp1, timestamp2, timestamp3]
				.filter(t => t && !isNaN(Number(t)))
				.map(t => Number(t));
			
			const createdTimestamp = timestamps[0] || 0;
			const updatedTimestamp = timestamps[timestamps.length - 1] || 0;

			// Bersihin URL dari parameter tambahan
			const cleanUrl = url.split('=')[0]; // Hapus =wxxx-hxxx

			return {
				url: cleanUrl,
				fullUrl: url, // URL asli dengan ukuran
				width: Number(width),
				height: Number(height),
				createdTimestamp,
				updatedTimestamp,
			};
		});

		// Deduplikasi berdasarkan URL
		const deduplicated = [...new Map(images.map((image) => [image.url, image])).values()];
		
		// Urutin berdasarkan createdTimestamp (yang paling baru di atas)
		const sortedImages = deduplicated.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
		
		return jsonResponse(
			{ 
				title: albumTitle,
				images: sortedImages, 
				count: sortedImages.length,
				albumUrl: albumUrl,
				fetchedAt: new Date().toISOString()
			},
			{
				status: 200,
				allowOrigin: env.ALLOW_ORIGIN,
				extraHeaders: { 
					'Cache-Control': env.CACHE_CONTROL || 'max-age=604800, stale-while-revalidate' 
				},
			}
		);
	} catch (error: any) {
		return jsonResponse(
			{ error: `Failed to process album: ${error.message}` }, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}
};

const jsonResponse = (data: any, params: { status?: number; allowOrigin?: string; extraHeaders?: Record<string, string> }) => {
	return new Response(JSON.stringify(data), {
		status: params.status || 200,
		headers: { 
			'content-type': 'application/json', 
			'Access-Control-Allow-Origin': params.allowOrigin || '*', 
			...params.extraHeaders 
		},
	});
};

const handleOptions = async (env: Env): Promise<Response> => {
	return new Response(null, {
		status: 204,
		headers: {
			Allow: 'GET, OPTIONS',
			'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Max-Age': '86400',
		},
	});
};
