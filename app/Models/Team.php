<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Team extends Model
{
    use HasUlids,
        SoftDeletes,
        HasFactory;

    protected $fillable = [
        'user_id',
        'name',
        'bio',
        'website',
        'links',
    ];

    protected $casts = [
        'id' => 'string',
        'links' => 'array',
    ];
}
