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
	try {
		// Coba ambil dari query parameter dulu
		const url = new URL(request.url);
		let queryAlbumUrl = url.searchParams.get('url');
		
		// Kalo url nya cuma ID doang (format pendek), tambahin base URL
		if (queryAlbumUrl && !queryAlbumUrl.startsWith('http')) {
			queryAlbumUrl = `https://photos.app.goo.gl/${queryAlbumUrl}`;
		}
		
		// Fallback ke env variable kalo ga ada query parameter
		const albumUrl = queryAlbumUrl?.trim() || env.ALBUM_URL?.trim();

		if (!albumUrl) {
			return jsonResponse({ 
				error: 'ALBUM_URL not set. Provide ?url= parameter or set env variable' 
			}, { status: 500, allowOrigin: env.ALLOW_ORIGIN });
		}

		// Fetch album page
		const resp = await fetch(`${albumUrl}?_imcp=1`, { 
			redirect: 'follow',
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			}
		});
		
		const text = await resp.text();

		// Ambil title album dari meta tag
		let title = 'Untitled Album';
		const titleMatch = text.match(/<title>(.*?)<\/title>/);
		if (titleMatch) {
			title = titleMatch[1].replace(/\s*-\s*Google\s*Photos\s*$/i, '').trim();
		}

		// Regex untuk gambar (yang udah ada)
		const imageMatches = [
			...text.matchAll(
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+)[^\]]+\][^\]]+\]\],(\d+),[^,]+,[^,]+,(\d+)/g,
			),
		];
		
		const images = imageMatches.flatMap(([, url, width, height, createdTimestamp, updatedTimestamp]) => {
			if (!url || !width || !height) return [];
			return {
				url,
				width: Number(width),
				height: Number(height),
				createdTimestamp: Number(createdTimestamp),
				updatedTimestamp: Number(updatedTimestamp),
				type: 'image'
			};
		});

		// Regex untuk video (format baru yang minta)
		const videoMatches = [
			...text.matchAll(
				/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+)",(\d+),(\d+),.*?,"(https:\/\/lh3\.googleusercontent\.com\/pw\/[\/a-zA-Z0-9_-]+=w\d+-h\d+-no)".*?,\[(\d+),(\d+)\],.*?,"(.*?)",.*?,"(.*?)",.*?,(\d+),(\d+),(\d+),.*?,(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),.*?,(true|false),.*?,(true|false),.*?,(\d+),.*?,(\d+),.*?,(\d+)/g
			),
		];

		const videos = videoMatches.flatMap((match) => {
			try {
				const [
					_full,
					baseUrl,
					width,
					height,
					thumbnailUrl,
					videoWidth,
					videoHeight,
					duration,
					videoId,
					createdYear,
					createdMonth,
					createdDay,
					_hour,
					_minute,
					_second,
					_milli,
					_unk1,
					_unk2,
					_unk3,
					_unk4,
					_unk5,
					_unk6,
					_unk7,
					_unk8,
					_unk9,
					_unk10,
					hasVideo,
					hasAudio,
					fileSize,
					_bitrate,
					fps
				] = match;

				if (!baseUrl) return [];

				// Generate video sources untuk berbagai kualitas
				const sources = [];
				const qualities = [
					{ label: '1080p', itag: 'm37' }, // 1080p
					{ label: '720p', itag: 'm22' },  // 720p
					{ label: '480p', itag: 'm18' },  // 480p
					{ label: '360p', itag: 'm18' },  // 360p (fallback)
				];

				for (const quality of qualities) {
					sources.push({
						file: `${baseUrl}=${quality.itag}`,
						label: quality.label,
						type: 'video/mp4'
					});
				}

				// Format thumbnail
				const thumbnail = thumbnailUrl ? 
					thumbnailUrl.replace(/=w\d+-h\d+-no$/, '=w1280-h720-no') : 
					`${baseUrl}=w1280-h720-no`;

				return [{
					title: title,
					status: true,
					sources: sources,
					image: thumbnail,
					host: 'googlephotos',
					vtt: null,
					duration: duration ? parseInt(duration) : 0,
					width: parseInt(videoWidth) || 1920,
					height: parseInt(videoHeight) || 1080,
					hasVideo: hasVideo === 'true',
					hasAudio: hasAudio === 'true',
					fileSize: fileSize ? parseInt(fileSize) : 0,
					fps: fps ? parseInt(fps) : 30,
					createdAt: createdYear ? `${createdYear}-${createdMonth}-${createdDay}` : null,
					videoId: videoId,
					type: 'video'
				}];
			} catch (e) {
				console.error('Error parsing video:', e);
				return [];
			}
		});

		// Gabungin images dan videos, lalu deduplicate based on URL
		const allItems = [...images, ...videos];
		const deduplicated = [...new Map(allItems.map((item) => [item.url || item.sources?.[0]?.file, item])).values()];

		// Format output sesuai permintaan
		const output = {
			title: title,
			images: videos.length > 0 ? videos : deduplicated, // Prioritaskan format video kalo ada
			count: videos.length || deduplicated.length,
			albumUrl: albumUrl,
			fetchedAt: new Date().toISOString()
		};

		return jsonResponse(
			output,
			{
				status: 200,
				allowOrigin: env.ALLOW_ORIGIN,
				extraHeaders: { 
					'Cache-Control': env.CACHE_CONTROL || 'max-age=604800, stale-while-revalidate' 
				},
			}
		);

	} catch (error: any) {
		return jsonResponse({ 
			error: error.message || 'Internal Server Error',
			title: 'Error',
			images: [],
			count: 0,
			albumUrl: null,
			fetchedAt: new Date().toISOString()
		}, { status: 500, allowOrigin: env.ALLOW_ORIGIN });
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
