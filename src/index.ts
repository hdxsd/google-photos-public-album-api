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
	
	// Kalo ga ada parameter url, coba pake env variable
	if (!albumUrl) {
		albumUrl = env.ALBUM_URL?.trim();
	}

	if (!albumUrl) {
		return jsonResponse(
			{ 
				error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable',
				title: null,
				images: [],
				count: 0,
				albumUrl: null,
				fetchedAt: new Date().toISOString()
			}, 
			{ status: 400, allowOrigin: env.ALLOW_ORIGIN }
		);
	}

	// Handle short URL (photos.app.goo.gl/xxxxx)
	if (!albumUrl.startsWith('http')) {
		// Kalo cuma kode pendek, ubah jadi full URL
		if (!albumUrl.includes('photos.app.goo.gl/')) {
			albumUrl = `https://photos.app.goo.gl/${albumUrl}`;
		}
	}

	try {
		// Fetch album page
		const resp = await fetch(albumUrl, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
			}
		});
		
		if (!resp.ok) {
			throw new Error(`Failed to fetch album: ${resp.status}`);
		}
		
		const text = await resp.text();

		// Ambil judul album dari <title>
		const titleMatch = text.match(/<title>(.+?)<\/title>/);
		let title = titleMatch ? titleMatch[1].replace(/\s*-\s*Google\s*Photos\s*$/i, '').trim() : 'Untitled Album';

		// Regex buat ambil semua foto
		const matches = [
			...text.matchAll(
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+)[^\]]+\][^\]]+\]\],(\d+),[^,]+,[^,]+,(\d+)/g,
			),
		];
		
		const images = matches.flatMap(([, url, width, height, createdTimestamp, updatedTimestamp]) => {
			if (!url || !width || !height) {
				return [];
			}

			// Generate thumbnail URLs dengan berbagai ukuran
			const baseUrl = url.split('=')[0]; // Hapus parameter

			return {
				url: `${baseUrl}=w${width}-h${height}-no?authuser=0`, // Original
				thumbnail: `${baseUrl}=w400-h300-c`, // Thumbnail 400x300 cropped
				preview: `${baseUrl}=w1024`, // Preview 1024px width
				width: Number(width),
				height: Number(height),
				createdTimestamp: Number(createdTimestamp),
				updatedTimestamp: Number(updatedTimestamp),
				createdAt: new Date(Number(createdTimestamp)).toISOString(),
				updatedAt: new Date(Number(updatedTimestamp)).toISOString(),
			};
		});

		// Hapus duplikat berdasarkan URL
		const deduplicated = [...new Map(images.map((image) => [image.url, image])).values()];

		// Sort by created timestamp (newest first)
		deduplicated.sort((a, b) => b.createdTimestamp - a.createdTimestamp);

		const response = {
			title,
			images: deduplicated,
			count: deduplicated.length,
			albumUrl: albumUrl,
			fetchedAt: new Date().toISOString()
		};

		return jsonResponse(
			response,
			{
				status: 200,
				allowOrigin: env.ALLOW_ORIGIN,
				extraHeaders: { 
					'Cache-Control': env.CACHE_CONTROL || 'max-age=3600, stale-while-revalidate' // Cache 1 jam
				},
			}
		);

	} catch (error: any) {
		return jsonResponse(
			{ 
				error: error.message,
				title: null,
				images: [],
				count: 0,
				albumUrl: albumUrl,
				fetchedAt: new Date().toISOString()
			}, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}
};

const jsonResponse = (data: any, params: { status?: number; allowOrigin?: string; extraHeaders?: Record<string, string> }) => {
	return new Response(JSON.stringify(data, null, 2), { // Pretty print JSON
		status: params.status || 200,
		headers: { 
			'content-type': 'application/json;charset=UTF-8', 
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
