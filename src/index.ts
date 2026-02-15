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

		// Ambil judul album dari <title>
		const titleMatch = text.match(/<title>(.+?) - Google Photos<\/title>/);
		const albumTitle = titleMatch ? titleMatch[1].trim() : 'Untitled Album';

		// Regex buat ambil semua foto - improved version
		const imageRegex = /\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_\-]+)",(\d+),(\d+)[^\]]+\](?:[^\[]*\[[^\]]*\])*?[^\]]+\]\],(\d+),(\d+),(\d+)/g;
		
		const matches = [...text.matchAll(imageRegex)];
		
		console.log(`Found ${matches.length} raw matches`); // Debug log

		const images = matches.flatMap((match) => {
			try {
				const [, url, width, height, createdTimestamp, updatedTimestamp, uploadTimestamp] = match;
				
				if (!url || !width || !height) {
					return [];
				}

				// Konversi ke number dan validasi
				const widthNum = Number(width);
				const heightNum = Number(height);
				const createdNum = Number(createdTimestamp);
				const updatedNum = Number(updatedTimestamp);
				const uploadedNum = Number(uploadTimestamp);

				// Pilih timestamp yang valid (prioritas: created > uploaded > updated)
				let timestamp = createdNum > 0 ? createdNum : (uploadedNum > 0 ? uploadedNum : updatedNum);
				
				// Kalo semua 0, pake current time
				if (timestamp <= 0) {
					timestamp = Date.now() / 1000;
				}

				return {
					url: url.split('=')[0], // Bersihin URL dari parameter tambahan
					width: widthNum,
					height: heightNum,
					timestamp: timestamp,
					createdTimestamp: createdNum || timestamp,
					updatedTimestamp: updatedNum || timestamp,
					uploadedTimestamp: uploadedNum || timestamp,
				};
			} catch (e) {
				console.error('Error parsing match:', e);
				return [];
			}
		});

		// Deduplikasi berdasarkan URL
		const uniqueImages = new Map();
		images.forEach(img => {
			const key = img.url.split('=')[0]; // Key based on base URL
			if (!uniqueImages.has(key) || uniqueImages.get(key).timestamp < img.timestamp) {
				uniqueImages.set(key, img);
			}
		});

		const deduplicated = Array.from(uniqueImages.values());
		
		// Sort by timestamp (newest first)
		deduplicated.sort((a, b) => b.timestamp - a.timestamp);

		return jsonResponse(
			{ 
				title: albumTitle,
				images: deduplicated, 
				count: deduplicated.length,
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
	return new Response(JSON.stringify(data, null, 2), { // Added pretty print
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
