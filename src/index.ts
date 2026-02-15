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
	const url = new URL(request.url);
	let albumUrl = url.searchParams.get('url')?.trim();
	
	if (!albumUrl) {
		albumUrl = env.ALBUM_URL?.trim();
	}
	
	if (albumUrl && !albumUrl.startsWith('http')) {
		albumUrl = `https://photos.app.goo.gl/${albumUrl}`;
	}

	if (!albumUrl) {
		return jsonResponse(
			{ error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable' }, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}

	try {
		// Fetch dengan parameter yang tepat
		const resp = await fetch(albumUrl, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.5',
				'Cache-Control': 'no-cache',
				'Pragma': 'no-cache'
			}
		});
		
		if (!resp.ok) {
			return jsonResponse(
				{ error: `Failed to fetch album: ${resp.status}` }, 
				{ status: 502, allowOrigin: env.ALLOW_ORIGIN }
			);
		}
		
		const html = await resp.text();

		// Ambil title (bersihin dari " - Google Photos")
		let title = 'Untitled Album';
		const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
		if (titleMatch) {
			title = titleMatch[1].replace(/\s*-\s*Google\s*Photos\s*$/i, '').trim();
		}

		// CARA 1: Coba regex yang lebih fleksibel untuk data gambar
		const imageMatches = [
			// Format 1: array pattern dengan https://lh3.googleusercontent.com
			...html.matchAll(/\["(https:\/\/lh3\.googleusercontent\.com\/[^"]+?)",(\d+),(\d+)/g),
			
			// Format 2: pattern dengan proxy URL
			...html.matchAll(/"https:\/\/lh3\.googleusercontent\.com\/[^"]+?=w(\d+)-h(\d+)/g),
			
			// Format 3: cari semua URL gambar
			...html.matchAll(/(https:\/\/lh3\.googleusercontent\.com\/[^\s"']+?)(?=["'\s])/g)
		];

		// CARA 2: Coba cari di JSON data
		let jsonData = null;
		const jsonMatch = html.match(/AF_initDataCallback\s*\(\s*({.+?})\s*\)\s*;/g);
		if (jsonMatch) {
			for (const match of jsonMatch) {
				try {
					const jsonStr = match.replace(/^AF_initDataCallback\s*\(\s*/, '').replace(/\s*\);?\s*$/, '');
					const data = JSON.parse(jsonStr);
					if (data && typeof data === 'object') {
						jsonData = data;
						break;
					}
				} catch (e) {
					// Skip kalo gagal parse
				}
			}
		}

		// Proses gambar dari berbagai sumber
		const images = new Map();
		
		// Dari regex matches
		for (const match of imageMatches) {
			let url = match[1] || match[0];
			// Bersihin URL dari parameter tambahan
			url = url.split('=')[0].split('?')[0];
			
			if (url && url.includes('lh3.googleusercontent.com') && !images.has(url)) {
				images.set(url, {
					url,
					width: parseInt(match[2]) || 0,
					height: parseInt(match[3]) || 0,
				});
			}
		}

		// Kalo masih kosong, coba fetch dengan parameter _imcp=1 (seperti sebelumnya)
		if (images.size === 0) {
			const imcpResp = await fetch(`${albumUrl}?_imcp=1`, {
				headers: { 'User-Agent': 'Mozilla/5.0' }
			});
			const imcpText = await imcpResp.text();
			
			const imcpMatches = [
				...imcpText.matchAll(
					/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+)[^\]]+\][^\]]+\]\],(\d+),[^,]+,[^,]+,(\d+)/g,
				),
			];
			
			for (const match of imcpMatches) {
				if (match[1]) {
					images.set(match[1], {
						url: match[1],
						width: Number(match[2]) || 0,
						height: Number(match[3]) || 0,
						createdTimestamp: Number(match[4]) || 0,
						updatedTimestamp: Number(match[5]) || 0,
					});
				}
			}
		}

		// Konversi Map ke Array
		const imagesArray = Array.from(images.values());
		
		// Log untuk debugging (akan muncul di console Cloudflare)
		console.log(`Found ${imagesArray.length} images for album: ${title}`);
		
		return jsonResponse(
			{ 
				title,
				images: imagesArray, 
				count: imagesArray.length,
				albumUrl,
				fetchedAt: new Date().toISOString()
			},
			{
				status: 200,
				allowOrigin: env.ALLOW_ORIGIN,
				extraHeaders: { 
					'Cache-Control': env.CACHE_CONTROL || 'max-age=3600, stale-while-revalidate=86400' 
				},
			}
		);
	} catch (error: any) {
		console.error('Error:', error);
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
