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
	let queryAlbumUrl = url.searchParams.get('url');
	
	// Kalo query parameter cuma ID doang (format: 7QzAnueaCVnrQdiG7)
	if (queryAlbumUrl && !queryAlbumUrl.includes('http')) {
		queryAlbumUrl = `https://photos.app.goo.gl/${queryAlbumUrl}`;
	}
	
	// Fallback ke env variable kalo ga ada query parameter
	const albumUrl = queryAlbumUrl?.trim() || env.ALBUM_URL?.trim();

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
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}

	try {
		// Fetch album page
		const resp = await fetch(`${albumUrl}?_imcp=1`, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
			}
		});
		const text = await resp.text();

		// Extract album title from <title> tag
		let title = null;
		const titleMatch = text.match(/<title>(.+?)<\/title>/);
		if (titleMatch) {
			title = titleMatch[1].replace(' - Google Photos', '').trim();
		}

		// Regex buat nangkep semua video - improved version
		// Format: ["https://lh3.googleusercontent.com/pw/...", width, height, ...]
		const videoRegex = /\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+)[^\]]*\].*?(?:video|mp4).*?\]/gi;
		
		// Alternative: cari semua URL yang match pattern Google Photos
		const urlRegex = /(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)/g;
		
		// Cari semua matches pake regex pertama
		const matches = [...text.matchAll(videoRegex)];
		
		// Kalo pake regex pertama gagal, coba metode kedua
		let videoUrls = [];
		if (matches.length === 0) {
			// Ambil semua URL dulu
			const allUrls = [...new Set(text.match(urlRegex) || [])];
			
			// Filter yang kemungkinan video (biasanya ada parameter video di sekitarnya)
			videoUrls = allUrls.filter(url => {
				const context = text.substring(Math.max(0, text.indexOf(url) - 200), Math.min(text.length, text.indexOf(url) + 200));
				return context.includes('video') || context.includes('mp4') || context.includes('mime');
			});
		}

		// Process videos
		const videos = new Map(); // Pake Map buat deduplikasi
		
		// Dari regex matches
		for (const match of matches) {
			const baseUrl = match[1];
			if (!baseUrl || videos.has(baseUrl)) continue;
			
			const width = match[2] ? parseInt(match[2]) : 1920;
			const height = match[3] ? parseInt(match[3]) : 1080;
			
			videos.set(baseUrl, { baseUrl, width, height });
		}
		
		// Dari URL list
		for (const url of videoUrls) {
			if (videos.has(url)) continue;
			
			// Coba cari dimensi di sekitar URL
			const context = text.substring(Math.max(0, text.indexOf(url) - 100), Math.min(text.length, text.indexOf(url) + 100));
			const dimMatch = context.match(/,(\d+),(\d+)/);
			
			videos.set(url, { 
				baseUrl: url, 
				width: dimMatch ? parseInt(dimMatch[1]) : 1920,
				height: dimMatch ? parseInt(dimMatch[2]) : 1080
			});
		}

		// Kalo masih kosong, coba pake regex foto sebagai fallback
		if (videos.size === 0) {
			const photoRegex = /\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+)[^\]]+\][^\]]+\]\],(\d+),[^,]+,[^,]+,(\d+)/g;
			const photoMatches = [...text.matchAll(photoRegex)];
			
			for (const match of photoMatches) {
				const baseUrl = match[1];
				if (!baseUrl || videos.has(baseUrl)) continue;
				
				videos.set(baseUrl, {
					baseUrl,
					width: parseInt(match[2]),
					height: parseInt(match[3])
				});
			}
		}

		console.log(`Found ${videos.size} videos`); // Debug log

		// Convert ke array dan buat output
		const videoList = await Promise.all([...videos.values()].map(async (video) => {
			// Generate thumbnail
			const thumbnail = `${video.baseUrl}=w1280-h720-no`;
			
			// Tentukan resolusi berdasarkan tinggi
			const resolutions = [];
			if (video.height >= 1080) {
				resolutions.push('m37'); // 1080p
				resolutions.push('m22'); // 720p
				resolutions.push('m18'); // 360p
			} else if (video.height >= 720) {
				resolutions.push('m22'); // 720p
				resolutions.push('m18'); // 360p
			} else {
				resolutions.push('m18'); // 360p
			}
			
			// Buat sources
			const sources = resolutions.map(res => ({
				file: `${video.baseUrl}=${res}`,
				label: res === 'm37' ? '1080p' : res === 'm22' ? '720p' : '360p',
				type: 'video/mp4'
			}));
			
			return {
				title: title || 'Untitled Video',
				status: true,
				sources,
				image: thumbnail,
				host: 'googlephotos',
				vtt: null
			};
		}));
		
		return jsonResponse(
			{ 
				title,
				images: videoList,
				count: videoList.length,
				albumUrl,
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

	} catch (error) {
		return jsonResponse(
			{ 
				error: error.message,
				title: null,
				images: [],
				count: 0,
				albumUrl,
				fetchedAt: new Date().toISOString()
			}, 
			{ status: 500, allowOrigin: env.ALLOW_ORIGIN }
		);
	}
};

const jsonResponse = (data: any, params: { status?: number; allowOrigin?: string; extraHeaders?: Record<string, string> }) => {
	return new Response(JSON.stringify(data, null, 2), {
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
