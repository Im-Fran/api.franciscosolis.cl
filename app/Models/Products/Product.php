<?php

namespace App\Models\Products;

use Cog\Contracts\Ownership\Ownable;
use Cog\Laravel\Ownership\Traits\HasOwner;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;
use Spatie\Sluggable\HasSlug;
use Spatie\Sluggable\SlugOptions;

class Product extends Model implements Ownable {
    use SoftDeletes,
        HasOwner,
        HasSlug,
        HasFactory;

    protected $fillable = [
        'name',
        'slug',
        'compatible_systems',
        'compatible_versions',
        'license',
        'access_requirements',
        'links',
        'supported_languages',
        'product_icon',
        'product_banner',
    ];

    protected $casts = [
        'compatible_versions' => 'array',
        'access_requirements' => 'array',
        'links' => 'array',
        'supported_languages' => 'array',
    ];

    public function getSlugOptions(): SlugOptions {
        return SlugOptions::create()
            ->generateSlugsFrom('name')
            ->saveSlugsTo('slug');
    }
}
