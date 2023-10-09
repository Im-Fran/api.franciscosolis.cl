<?php

namespace App\Models\Products;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Product extends Model
{
    use SoftDeletes, HasFactory;

    protected $fillable = [
        'name',
        'slug',
        'user_id',
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
}
